<?php
// WAMC server: one password, photos and garment list kept on the hosting.
// Nothing here is secret. The password hash and all data live in the data
// folder, which is created on the server and never committed.

const MAX_ITEMS = 2000;
const MAX_PHOTO_BYTES = 1048576;
const MAX_PHOTO_SIDE = 2000;
const MAX_USES = 200;
const MIN_PASSWORD = 8;
const MAX_FAILS = 5;
const LOCK_SECONDS = 900;
const SESSION_SECONDS = 7776000; // 90 days
const COOKIE = 'wamc';

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
    $env = getenv('WAMC_DATA');
    $candidates = $env ? [$env] : [dirname(__DIR__, 2) . '/wamc-data', __DIR__ . '/data'];
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
    fail(500, 'El servidor no puede guardar datos.');
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
        fail(500, 'El servidor no puede guardar datos.');
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
        fail(429, 'Demasiados intentos. Espera 15 minutos y vuelve a probar.');
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
        fail(401, 'Contraseña incorrecta.');
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
        fail(400, 'La contraseña necesita al menos ' . MIN_PASSWORD . ' caracteres.');
    }
    $handle = @fopen(data_dir() . '/config.json', 'x');
    if (!$handle) {
        fail(409, 'La contraseña ya está creada.');
    }
    fwrite($handle, json_encode(['password' => password_hash($password, PASSWORD_DEFAULT)]));
    fclose($handle);
    start_session();
}

// ── Garments ──

function clean_text(string $value, int $max): string
{
    $value = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '');
    return mb_substr($value, 0, $max);
}

function clean_date(string $value): string
{
    if ($value === '') {
        return '';
    }
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        fail(400, 'La fecha no es válida.');
    }
    return $value;
}

// The "when I wore it" list arrives as JSON: [{date, place}, ...]. Empty entries are dropped.
function clean_uses(string $json): array
{
    $list = $json === '' ? [] : json_decode($json, true);
    if (!is_array($list) || count($list) > MAX_USES) {
        fail(400, 'La lista de usos no es válida.');
    }
    $uses = [];
    foreach ($list as $use) {
        if (!is_array($use)) {
            fail(400, 'La lista de usos no es válida.');
        }
        $date = clean_date((string) ($use['date'] ?? ''));
        $place = clean_text((string) ($use['place'] ?? ''), 60);
        if ($date !== '' || $place !== '') {
            $uses[] = ['date' => $date, 'place' => $place];
        }
    }
    usort($uses, function ($a, $b) {
        return strcmp($b['date'], $a['date']);
    });
    return $uses;
}

// Garments saved by earlier versions lack the newer fields, or hold a single use.
function with_all_fields(array $item): array
{
    if (!isset($item['worn'])) {
        $date = $item['wornDate'] ?? '';
        $place = $item['wornPlace'] ?? '';
        $item['worn'] = ($date !== '' || $place !== '') ? [['date' => $date, 'place' => $place]] : [];
    }
    unset($item['wornDate'], $item['wornPlace']);
    return $item + ['color' => '', 'fabric' => '', 'placePhoto' => ''];
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
        fail(400, 'La foto no ha llegado. Vuelve a intentarlo.');
    }
    if ($upload['size'] > MAX_PHOTO_BYTES) {
        fail(413, 'La foto pesa demasiado.');
    }
    $info = @getimagesize($upload['tmp_name']);
    if (!$info || $info[2] !== IMAGETYPE_JPEG || $info[0] > MAX_PHOTO_SIDE || $info[1] > MAX_PHOTO_SIDE) {
        fail(400, 'El archivo no es una foto válida.');
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
        'type' => clean_text((string) ($_POST['type'] ?? ''), 40),
        'place' => clean_text((string) ($_POST['place'] ?? ''), 60),
        'color' => clean_text((string) ($_POST['color'] ?? ''), 30),
        'fabric' => clean_text((string) ($_POST['fabric'] ?? ''), 30),
        'worn' => clean_uses((string) ($_POST['worn'] ?? '')),
    ];
    if ($fields['type'] === '' || $fields['place'] === '') {
        fail(400, 'Falta el tipo de prenda o el lugar.');
    }
    if ($id !== '' && !preg_match('/^[a-f0-9]{16}$/', $id)) {
        fail(400, 'Prenda desconocida.');
    }
    $isNew = $id === '';
    $full = 'El armario está lleno. Borra alguna prenda para añadir otra.';
    if ($isNew && count(store_read('items')) >= MAX_ITEMS) {
        fail(409, $full);
    }

    // Check every upload before writing any, so a bad one leaves nothing behind.
    $hasPlacePhoto = was_uploaded('placePhoto');
    if ($isNew) {
        check_photo('photo');
    }
    if ($hasPlacePhoto) {
        check_photo('placePhoto');
    }
    $photo = $isNew ? store_photo('photo') : null;
    $placePhoto = $hasPlacePhoto ? store_photo('placePhoto') : null;
    if (($isNew && !$photo) || ($hasPlacePhoto && !$placePhoto)) {
        drop_photos($photo, $placePhoto);
        fail(500, 'El servidor no ha podido guardar la foto.');
    }

    if ($isNew) {
        $item = ['id' => bin2hex(random_bytes(8))] + $fields
            + ['photo' => $photo, 'placePhoto' => $placePhoto ?? '', 'created' => time()];
        $added = store_update('items', function (array &$items) use ($item) {
            if (count($items) >= MAX_ITEMS) {
                return false;
            }
            $items[] = $item;
            return true;
        });
        if (!$added) {
            drop_photos($photo, $placePhoto);
            fail(409, $full);
        }
        return $item;
    }

    $replacePlacePhoto = $hasPlacePhoto || ($_POST['removePlacePhoto'] ?? '') === '1';
    $oldPlacePhoto = null;
    $item = store_update('items', function (array &$items) use ($id, $fields, $replacePlacePhoto, $placePhoto, &$oldPlacePhoto) {
        foreach ($items as &$item) {
            if ($item['id'] === $id) {
                $item = array_merge(with_all_fields($item), $fields);
                if ($replacePlacePhoto) {
                    $oldPlacePhoto = $item['placePhoto'] ?? '';
                    $item['placePhoto'] = $placePhoto ?? '';
                }
                return $item;
            }
        }
        return null;
    });
    if (!$item) {
        drop_photos($placePhoto);
        fail(404, 'Esa prenda ya no existe.');
    }
    drop_photos($oldPlacePhoto);
    return $item;
}

function delete_item(string $id): void
{
    $photos = store_update('items', function (array &$items) use ($id) {
        foreach ($items as $index => $item) {
            if ($item['id'] === $id) {
                array_splice($items, $index, 1);
                return [$item['photo'], $item['placePhoto'] ?? ''];
            }
        }
        return [];
    });
    drop_photos(...$photos);
}

function send_photo(string $name): void
{
    if (!preg_match('/^[a-f0-9]{32}$/', $name) || !is_file(photo_path($name))) {
        fail(404, 'Foto no encontrada.');
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
$writes = ['setup', 'login', 'logout', 'save', 'delete'];

if (in_array($action, $writes, true)) {
    // A custom header cannot be sent by another site's form or image tag.
    if ($method !== 'POST' || ($_SERVER['HTTP_X_WAMC'] ?? '') !== '1') {
        fail(400, 'Petición no válida.');
    }
} elseif ($method !== 'GET') {
    fail(405, 'Petición no válida.');
}

$body = [];
if (in_array($action, ['setup', 'login', 'delete'], true)) {
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
    fail(401, 'Escribe la contraseña para entrar.');
}

switch ($action) {
    case 'logout':
        end_session();
        ok();

    case 'list':
        ok(['items' => array_map('with_all_fields', store_read('items'))]);

    case 'save':
        ok(['item' => save_item()]);

    case 'delete':
        delete_item((string) ($body['id'] ?? ''));
        ok();

    case 'photo':
        send_photo((string) ($_GET['f'] ?? ''));

    default:
        fail(404, 'Petición no válida.');
}
