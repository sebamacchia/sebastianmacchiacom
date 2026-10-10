<?php
// My records server: one password, photos and record list kept on the hosting.
// Nothing here is secret. The password hash and all data live in the data
// folder, which is created on the server and never committed.

const MAX_ITEMS = 5000;
const MAX_PHOTO_BYTES = 1048576;
const MAX_PHOTO_SIDE = 2000;
const MAX_LISTENS = 500;
const MIN_PASSWORD = 8;
const MAX_FAILS = 5;
const LOCK_SECONDS = 900;
const SESSION_SECONDS = 7776000; // 90 days
const COOKIE = 'myrecords';
const OPENAI_MODEL = 'gpt-5-mini';
const OPENAI_SECONDS = 60;

// Warnings must never be printed into a JSON reply.
ini_set('display_errors', '0');

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function fail(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $message]);
    exit;
}

function ok(array $data = []): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data + ['ok' => true]);
    exit;
}

// ── Storage ──

// Prefer a folder outside the web root; fall back to a locked folder beside this file.
function data_dir(): string
{
    static $dir = null;
    if ($dir !== null) {
        return $dir;
    }
    $env = getenv('MYRECORDS_DATA');
    $candidates = $env ? [$env] : [dirname(__DIR__, 2) . '/myrecords-data', __DIR__ . '/data'];
    foreach ($candidates as $candidate) {
        if (!@is_dir($candidate)) {
            @mkdir($candidate, 0700, true);
        }
        if (@is_dir($candidate) && @is_writable($candidate)) {
            if (!@is_dir("$candidate/photos")) {
                @mkdir("$candidate/photos", 0700);
            }
            if (!@is_file("$candidate/.htaccess")) {
                @file_put_contents("$candidate/.htaccess", "Require all denied\n");
            }
            return $dir = $candidate;
        }
    }
    fail(500, 'The server cannot save data.');
}

function store_read(string $name): array
{
    $raw = @file_get_contents(data_dir() . "/$name.json");
    $data = $raw ? json_decode($raw, true) : null;
    return is_array($data) ? $data : [];
}

// Read, change and write one JSON file under an exclusive lock.
function store_update(string $name, callable $change)
{
    $handle = fopen(data_dir() . "/$name.json", 'c+');
    if (!$handle || !flock($handle, LOCK_EX)) {
        fail(500, 'The server cannot save data.');
    }
    $data = json_decode(stream_get_contents($handle) ?: '', true);
    if (!is_array($data)) {
        $data = [];
    }
    $result = $change($data);
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($data, JSON_UNESCAPED_UNICODE));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $result;
}

function photo_path(string $name): string
{
    return data_dir() . "/photos/$name.jpg";
}

// ── Password and sessions ──

function is_local(): bool
{
    $host = strtolower(explode(':', $_SERVER['HTTP_HOST'] ?? '')[0]);
    return $host === 'localhost' || $host === '127.0.0.1';
}

function set_session_cookie(string $value, int $expires): void
{
    $path = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/';
    setcookie(COOKIE, $value, [
        'expires' => $expires,
        'path' => $path,
        'secure' => !is_local(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function signed_in(): bool
{
    $token = $_COOKIE[COOKIE] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        return false;
    }
    $expires = store_read('sessions')[hash('sha256', $token)] ?? 0;
    return $expires > time();
}

function start_session(): void
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + SESSION_SECONDS;
    store_update('sessions', function (array &$sessions) use ($token, $expires) {
        $now = time();
        $sessions = array_filter($sessions, function ($until) use ($now) {
            return $until > $now;
        });
        $sessions[hash('sha256', $token)] = $expires;
    });
    set_session_cookie($token, $expires);
}

function end_session(): void
{
    $token = $_COOKIE[COOKIE] ?? '';
    if (is_string($token) && $token !== '') {
        store_update('sessions', function (array &$sessions) use ($token) {
            unset($sessions[hash('sha256', $token)]);
        });
    }
    set_session_cookie('', time() - 3600);
}

function recent_fails(array $attempts, string $ip): array
{
    $since = time() - LOCK_SECONDS;
    return array_values(array_filter($attempts[$ip] ?? [], function ($at) use ($since) {
        return $at > $since;
    }));
}

function login(string $password): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (count(recent_fails(store_read('attempts'), $ip)) >= MAX_FAILS) {
        fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    }
    $hash = store_read('config')['password'] ?? '';
    if ($hash === '' || !password_verify($password, $hash)) {
        store_update('attempts', function (array &$attempts) use ($ip) {
            $kept = [];
            foreach (array_keys($attempts) as $seen) {
                $fails = recent_fails($attempts, $seen);
                if ($fails) {
                    $kept[$seen] = $fails;
                }
            }
            $kept[$ip][] = time();
            $attempts = $kept;
        });
        fail(401, 'Wrong password.');
    }
    store_update('attempts', function (array &$attempts) use ($ip) {
        unset($attempts[$ip]);
    });
    start_session();
}

// The first visitor after installing chooses the password. Creating the file
// with mode "x" makes this possible exactly once.
function setup(string $password): void
{
    if (strlen($password) < MIN_PASSWORD) {
        fail(400, 'The password needs at least ' . MIN_PASSWORD . ' characters.');
    }
    $handle = @fopen(data_dir() . '/config.json', 'x');
    if (!$handle) {
        fail(409, 'The password has already been created.');
    }
    fwrite($handle, json_encode(['password' => password_hash($password, PASSWORD_DEFAULT)]));
    fclose($handle);
    start_session();
}

// ── Records ──

// Control characters become spaces. With $lines, line breaks are kept.
function clean_text(string $value, int $max, bool $lines = false): string
{
    $junk = $lines ? '/[\x00-\x09\x0B-\x1F\x7F]+/u' : '/[\x00-\x1F\x7F]+/u';
    $value = trim(preg_replace($junk, ' ', $value) ?? '');
    return mb_substr($value, 0, $max);
}

function clean_date(string $value): string
{
    if ($value === '') {
        return '';
    }
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        fail(400, 'That date is not valid.');
    }
    return $value;
}

function clean_year(string $value): string
{
    if ($value === '') {
        return '';
    }
    if (!preg_match('/^\d{4}$/', $value) || (int) $value < 1900 || (int) $value > 2100) {
        fail(400, 'That year is not valid.');
    }
    return $value;
}

// The "when I listened to it" list arrives as JSON: [{date, note}, ...]. Empty entries are dropped.
function clean_listens(string $json): array
{
    $list = $json === '' ? [] : json_decode($json, true);
    if (!is_array($list) || count($list) > MAX_LISTENS) {
        fail(400, 'The listening history is not valid.');
    }
    $listens = [];
    foreach ($list as $listen) {
        if (!is_array($listen)) {
            fail(400, 'The listening history is not valid.');
        }
        $date = clean_date((string) ($listen['date'] ?? ''));
        $note = clean_text((string) ($listen['note'] ?? ''), 80);
        if ($date !== '' || $note !== '') {
            $listens[] = ['date' => $date, 'note' => $note];
        }
    }
    usort($listens, function ($a, $b) {
        return strcmp($b['date'], $a['date']);
    });
    return $listens;
}

function was_uploaded(string $field): bool
{
    return isset($_FILES[$field]) && ($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE;
}

// Accept only a real JPEG within the size limits.
function check_photo(string $field): void
{
    $upload = $_FILES[$field] ?? [];
    if (($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'])) {
        fail(400, 'The photo did not arrive. Try again.');
    }
    if ($upload['size'] > MAX_PHOTO_BYTES) {
        fail(413, 'The photo is too large.');
    }
    $info = @getimagesize($upload['tmp_name']);
    if (!$info || $info[2] !== IMAGETYPE_JPEG || $info[0] > MAX_PHOTO_SIDE || $info[1] > MAX_PHOTO_SIDE) {
        fail(400, 'That file is not a valid photo.');
    }
}

// Save a checked photo under a random name. It is re-encoded when GD is available
// so that nothing but pixels reaches the disk. Returns null if it cannot be saved.
function store_photo(string $field): ?string
{
    $tmp = $_FILES[$field]['tmp_name'];
    $name = bin2hex(random_bytes(16));
    if (function_exists('imagecreatefromjpeg')) {
        $image = @imagecreatefromjpeg($tmp);
        $saved = $image && imagejpeg($image, photo_path($name), 82);
    } else {
        $saved = move_uploaded_file($tmp, photo_path($name));
    }
    return $saved ? $name : null;
}

function drop_photos(?string ...$names): void
{
    foreach ($names as $name) {
        if ($name) {
            @unlink(photo_path($name));
        }
    }
}

function save_item(): array
{
    $id = (string) ($_POST['id'] ?? '');
    $fields = [
        'artist' => clean_text((string) ($_POST['artist'] ?? ''), 80),
        'album' => clean_text((string) ($_POST['album'] ?? ''), 100),
        'genre' => clean_text((string) ($_POST['genre'] ?? ''), 30),
        'year' => clean_year(trim((string) ($_POST['year'] ?? ''))),
        'label' => clean_text((string) ($_POST['label'] ?? ''), 60),
        'edition' => clean_text((string) ($_POST['edition'] ?? ''), 120),
        'price' => clean_text((string) ($_POST['price'] ?? ''), 30),
        'about' => clean_text((string) ($_POST['about'] ?? ''), 800),
        'samples' => clean_text(str_replace("\r", '', (string) ($_POST['samples'] ?? '')), 1000, true),
        'place' => clean_text((string) ($_POST['place'] ?? ''), 60),
        'listens' => clean_listens((string) ($_POST['listens'] ?? '')),
    ];
    if ($fields['artist'] === '' || $fields['album'] === '') {
        fail(400, 'The artist or the album is missing.');
    }
    if ($id !== '' && !preg_match('/^[a-f0-9]{16}$/', $id)) {
        fail(400, 'Unknown record.');
    }
    $isNew = $id === '';
    $full = 'The collection is full. Delete a record to add another.';
    if ($isNew && count(store_read('items')) >= MAX_ITEMS) {
        fail(409, $full);
    }

    // Check every upload before writing any, so a bad one leaves nothing behind.
    $hasBackPhoto = was_uploaded('backPhoto');
    if ($isNew) {
        check_photo('photo');
    }
    if ($hasBackPhoto) {
        check_photo('backPhoto');
    }
    $photo = $isNew ? store_photo('photo') : null;
    $backPhoto = $hasBackPhoto ? store_photo('backPhoto') : null;
    if (($isNew && !$photo) || ($hasBackPhoto && !$backPhoto)) {
        drop_photos($photo, $backPhoto);
        fail(500, 'The server could not save the photo.');
    }

    if ($isNew) {
        $item = ['id' => bin2hex(random_bytes(8))] + $fields
            + ['photo' => $photo, 'backPhoto' => $backPhoto ?? '', 'created' => time()];
        $added = store_update('items', function (array &$items) use ($item) {
            if (count($items) >= MAX_ITEMS) {
                return false;
            }
            $items[] = $item;
            return true;
        });
        if (!$added) {
            drop_photos($photo, $backPhoto);
            fail(409, $full);
        }
        return $item;
    }

    $replaceBackPhoto = $hasBackPhoto || ($_POST['removeBackPhoto'] ?? '') === '1';
    $oldBackPhoto = null;
    $item = store_update('items', function (array &$items) use ($id, $fields, $replaceBackPhoto, $backPhoto, &$oldBackPhoto) {
        foreach ($items as &$item) {
            if ($item['id'] === $id) {
                $item = array_merge($item, $fields);
                if ($replaceBackPhoto) {
                    $oldBackPhoto = $item['backPhoto'] ?? '';
                    $item['backPhoto'] = $backPhoto ?? '';
                }
                return $item;
            }
        }
        return null;
    });
    if (!$item) {
        drop_photos($backPhoto);
        fail(404, 'That record no longer exists.');
    }
    drop_photos($oldBackPhoto);
    return $item;
}

function delete_item(string $id): void
{
    $photos = store_update('items', function (array &$items) use ($id) {
        foreach ($items as $index => $item) {
            if ($item['id'] === $id) {
                array_splice($items, $index, 1);
                return [$item['photo'], $item['backPhoto'] ?? ''];
            }
        }
        return [];
    });
    drop_photos(...$photos);
}

// ── OpenAI: reads a cover photo and suggests the record's details ──

// The owner pastes the key in the app. It is kept in the data folder and never sent back.
function openai_key(): string
{
    return (string) (store_read('openai')['key'] ?? '');
}

// Returns [HTTP status, decoded reply].
function openai(string $path, string $key, ?array $body = null): array
{
    if (!function_exists('curl_init')) {
        fail(500, 'This server cannot connect to OpenAI.');
    }
    $request = curl_init((getenv('MYRECORDS_OPENAI_URL') ?: 'https://api.openai.com/v1') . $path);
    curl_setopt_array($request, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => OPENAI_SECONDS,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $key", 'Content-Type: application/json'],
    ]);
    if ($body !== null) {
        curl_setopt($request, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($request);
    if ($raw === false) {
        fail(502, 'Could not connect to OpenAI.');
    }
    $reply = json_decode($raw, true);
    return [curl_getinfo($request, CURLINFO_RESPONSE_CODE), is_array($reply) ? $reply : []];
}

// An empty key switches the feature off.
function set_openai_key(string $key): void
{
    if ($key !== '') {
        if (!preg_match('/^sk-[A-Za-z0-9_-]{20,300}$/', $key)) {
            fail(400, 'That does not look like an OpenAI key. They start with "sk-".');
        }
        if (openai('/models', $key)[0] === 401) {
            fail(400, 'OpenAI does not accept that key. Copy it again.');
        }
    }
    store_update('openai', function (array &$config) use ($key) {
        $config = $key === '' ? [] : ['key' => $key];
    });
}

// What OpenAI is asked for: field => [longest answer kept, what to write].
const OPENAI_FIELDS = [
    'artist' => [80, 'Artist or band.'],
    'album' => [100, 'Album title.'],
    'genre' => [30, 'Genre in one or two words.'],
    'year' => [4, 'Year the album was first released, four digits.'],
    'label' => [60, 'Record label of this pressing.'],
    'edition' => [120, 'This pressing as printed on the sleeve: catalogue number, country, pressing year, original or reissue.'],
    'price' => [30, 'Rough second-hand price range for this pressing in good condition, in US dollars, like "$15-30".'],
    'about' => [800, 'Three or four sentences about the album with one or two curiosities: how it was recorded, who plays on it, how it was received, well-known samples taken from it.'],
];

// Sends the cover photo, and the back cover when there is one, to OpenAI. For a saved
// record (id) the stored photos are used. Anything it is not sure about comes back empty.
function identify_record(): array
{
    $key = openai_key();
    if ($key === '') {
        fail(409, 'The OpenAI key is missing.');
    }
    $id = (string) ($_POST['id'] ?? '');
    $item = null;
    if ($id === '') {
        check_photo('photo');
        $photos = [$_FILES['photo']['tmp_name']];
    } else {
        foreach (store_read('items') as $saved) {
            if ($saved['id'] === $id) {
                $item = $saved;
            }
        }
        if (!$item) {
            fail(404, 'That record no longer exists.');
        }
        $photos = [photo_path($item['photo'])];
    }
    if (was_uploaded('backPhoto')) {
        check_photo('backPhoto');
        $photos[] = $_FILES['backPhoto']['tmp_name'];
    } elseif ($item && ($item['backPhoto'] ?? '') !== '') {
        $photos[] = photo_path($item['backPhoto']);
    }

    $genres = clean_text((string) ($_POST['genres'] ?? ''), 600);
    $content = [['type' => 'text', 'text' => 'These are photos of a vinyl record: the front cover'
        . (count($photos) > 1 ? ', then the back cover. Read the small print on the back for the label and the edition. ' : '. ')
        . 'Identify the release and fill in the fields, in English. '
        . ($genres === '' ? '' : "For the genre use one of these when it fits: $genres. ")
        . 'Use an empty string for any fact you cannot tell with confidence; the price is an estimate.']];
    foreach ($photos as $photo) {
        $content[] = ['type' => 'image_url', 'image_url' => [
            'url' => 'data:image/jpeg;base64,' . base64_encode((string) @file_get_contents($photo)),
            'detail' => 'high',
        ]];
    }
    $properties = [];
    foreach (OPENAI_FIELDS as $name => [, $description]) {
        $properties[$name] = ['type' => 'string', 'description' => $description];
    }
    [$status, $reply] = openai('/chat/completions', $key, [
        'model' => OPENAI_MODEL,
        'messages' => [['role' => 'user', 'content' => $content]],
        'response_format' => ['type' => 'json_schema', 'json_schema' => [
            'name' => 'record',
            'strict' => true,
            'schema' => [
                'type' => 'object',
                'properties' => $properties,
                'required' => array_keys($properties),
                'additionalProperties' => false,
            ],
        ]],
    ]);
    if ($status === 401) {
        fail(502, 'OpenAI no longer accepts the key. Change it at the bottom of the record list.');
    }
    if ($status === 429) {
        fail(502, 'OpenAI did not answer: the account has no credit or there are too many requests.');
    }
    if ($status !== 200) {
        fail(502, 'OpenAI failed: ' . clean_text((string) ($reply['error']['message'] ?? "error $status"), 200));
    }
    $found = json_decode((string) ($reply['choices'][0]['message']['content'] ?? ''), true);
    $record = [];
    foreach (OPENAI_FIELDS as $name => [$max]) {
        $record[$name] = is_array($found) && is_string($found[$name] ?? null) ? clean_text($found[$name], $max) : '';
    }
    if (!preg_match('/^\d{4}$/', $record['year']) || $record['year'] < 1900 || $record['year'] > 2100) {
        $record['year'] = '';
    }
    return $record;
}

function send_photo(string $name): void
{
    if (!preg_match('/^[a-f0-9]{32}$/', $name) || !is_file(photo_path($name))) {
        fail(404, 'Photo not found.');
    }
    header('Content-Type: image/jpeg');
    header('Content-Length: ' . filesize(photo_path($name)));
    header('Cache-Control: private, max-age=31536000, immutable');
    readfile(photo_path($name));
    exit;
}

// ── Routing ──

$action = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$writes = ['setup', 'login', 'logout', 'save', 'delete', 'identify', 'key'];

if (in_array($action, $writes, true)) {
    // A custom header cannot be sent by another site's form or image tag.
    if ($method !== 'POST' || ($_SERVER['HTTP_X_RECORDS'] ?? '') !== '1') {
        fail(400, 'Invalid request.');
    }
} elseif ($method !== 'GET') {
    fail(405, 'Invalid request.');
}

$body = [];
if (in_array($action, ['setup', 'login', 'delete', 'key'], true)) {
    $body = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($body)) {
        $body = [];
    }
}

$configured = is_file(data_dir() . '/config.json');

switch ($action) {
    case 'state':
        ok(['setup' => !$configured, 'auth' => $configured && signed_in()]);

    case 'setup':
        setup((string) ($body['password'] ?? ''));
        ok();

    case 'login':
        login((string) ($body['password'] ?? ''));
        ok();
}

if (!$configured || !signed_in()) {
    fail(401, 'Enter the password to continue.');
}

switch ($action) {
    case 'logout':
        end_session();
        ok();

    case 'list':
        ok(['items' => store_read('items'), 'ai' => openai_key() !== '']);

    case 'save':
        ok(['item' => save_item()]);

    case 'identify':
        ok(['record' => identify_record()]);

    case 'key':
        set_openai_key(trim((string) ($body['key'] ?? '')));
        ok();

    case 'delete':
        delete_item((string) ($body['id'] ?? ''));
        ok();

    case 'photo':
        send_photo((string) ($_GET['f'] ?? ''));

    default:
        fail(404, 'Invalid request.');
}
