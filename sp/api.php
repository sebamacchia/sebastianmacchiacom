<?php
// SP404MK2 crate server: one password, and the list of SP-404MKII projects,
// banks and samples kept on the hosting. Nothing here is secret. The password
// hash and all data live in the data folder, which is created on the server and
// never committed.
//
// crate.json = { projects: {id: Project}, overrides: {id: {padId: {name?, playSec?}}},
//                names: {id: name} }
// The override rules are the same as setOverride/clearOverride in js/store.js, so
// the page can show the crate with those pure functions. A rename lives in
// `names`, so reading the SD card again never undoes it.

// array_is_list is PHP 8.1+; the hosting's PHP version is not pinned.
if (!function_exists('array_is_list')) {
    function array_is_list(array $array): bool
    {
        return $array === [] || array_keys($array) === range(0, count($array) - 1);
    }
}

const MAX_PROJECTS = 300;
const MAX_BODY_BYTES = 2097152; // 2 MB
const MAX_NAME = 80;
const MAX_FOLDER = 255;
const MAX_SECONDS = 7200;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1000;
const MAX_FAILS = 5;
const LOCK_SECONDS = 900;
const SESSION_SECONDS = 7776000; // 90 days
const COOKIE = 'sp404crate';
const PAD_ID = '/^[A-J]([1-9]|1[0-6])$/';
const PAD_FIELDS = ['name', 'playSec', 'fullSec', 'channels', 'approx'];
// Keys the page never copies from data (see UNSAFE_KEYS in js/store.js).
const UNSAFE_IDS = ['__proto__', 'constructor', 'prototype'];
const JSON_OUT = JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP;

// Warnings must never be printed into a JSON reply.
ini_set('display_errors', '0');

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function reply(int $status, array $data): void
{
    $json = json_encode($data, JSON_OUT);
    if ($json === false) {
        $status = 500;
        $json = json_encode(['ok' => false, 'error' => 'The server could not answer.']);
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo $json;
    exit;
}

function fail(int $status, string $message): void
{
    reply($status, ['ok' => false, 'error' => $message]);
}

function ok(array $data = []): void
{
    reply(200, ['ok' => true] + $data);
}

// ── Storage ──

// Prefer a folder outside the web root; fall back to a locked folder beside this file.
function data_dir(): string
{
    static $dir = null;
    if ($dir !== null) {
        return $dir;
    }
    $env = getenv('SP404CRATE_DATA');
    $candidates = $env ? [$env] : [dirname(__DIR__, 2) . '/sp404crate-data', __DIR__ . '/data'];
    foreach ($candidates as $candidate) {
        if (!@is_dir($candidate)) {
            @mkdir($candidate, 0700, true);
        }
        if (@is_dir($candidate) && @is_writable($candidate)) {
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
// If $change calls fail(), the script stops before anything is written.
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
    $json = json_encode($data, JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        flock($handle, LOCK_UN);
        fclose($handle);
        fail(500, 'The server cannot save data.');
    }
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, $json);
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $result;
}

// ── Password and sessions ──

function is_local(): bool
{
    $host = strtolower(explode(':', $_SERVER['HTTP_HOST'] ?? '')[0]);
    return $host === 'localhost' || $host === '127.0.0.1';
}

// The cookie is limited to the folder that holds this file: /sp/ on the site.
function set_session_cookie(string $value, int $expires): void
{
    $path = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
    setcookie(COOKIE, $value, [
        'expires' => $expires,
        'path' => $path,
        'secure' => !is_local(),
        'httponly' => true,
        'samesite' => 'Lax',
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

// Only a hash of the token is kept, so a copy of the data folder cannot sign in.
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
    $list = is_array($attempts[$ip] ?? null) ? $attempts[$ip] : [];
    return array_values(array_filter($list, function ($at) use ($since) {
        return is_int($at) && $at > $since;
    }));
}

function login(string $password): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (count(recent_fails(store_read('attempts'), $ip)) >= MAX_FAILS) {
        fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    }
    $hash = store_read('auth')['password'] ?? '';
    if (!is_string($hash) || $hash === '' || !password_verify($password, $hash)) {
        store_update('attempts', function (array &$attempts) use ($ip) {
            $kept = [];
            foreach (array_keys($attempts) as $seen) {
                $fails = recent_fails($attempts, (string) $seen);
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
    if (is_file(data_dir() . '/auth.json')) {
        fail(409, 'The password has already been created.');
    }
    if (mb_strlen($password) < MIN_PASSWORD) {
        fail(400, 'The password needs at least ' . MIN_PASSWORD . ' characters.');
    }
    if (strlen($password) > MAX_PASSWORD) {
        fail(400, 'The password is too long.');
    }
    $handle = @fopen(data_dir() . '/auth.json', 'x');
    if (!$handle) {
        fail(409, 'The password has already been created.');
    }
    fwrite($handle, json_encode(['password' => password_hash($password, PASSWORD_DEFAULT)]));
    fclose($handle);
    start_session();
}

// ── Checking what arrives ──

// Control characters become spaces, then the text is trimmed and cut to $max.
function clean_text(string $value, int $max): string
{
    $value = trim(preg_replace('/[\p{Cc}\p{Zl}\p{Zp}]+/u', ' ', $value) ?? '');
    return mb_substr($value, 0, $max);
}

// A name from the page: a string, or null for "no name".
function clean_name($value): string
{
    if ($value === null) {
        return '';
    }
    if (!is_string($value)) {
        fail(400, 'That name is not valid.');
    }
    return clean_text($value, MAX_NAME);
}

function check_project_id($id): string
{
    if (!is_string($id) || $id === '' || mb_strlen($id) > 80 || preg_match('/[\p{Cc}]/u', $id) || in_array($id, UNSAFE_IDS, true)) {
        fail(400, 'Unknown project.');
    }
    return $id;
}

function check_pad_id($id): string
{
    if (!is_string($id) || !preg_match(PAD_ID, $id)) {
        fail(400, 'Unknown pad.');
    }
    return $id;
}

function is_seconds($value): bool
{
    return (is_int($value) || is_float($value)) && is_finite((float) $value)
        && $value >= 0 && $value <= MAX_SECONDS;
}

// A length typed in the pad sheet: null (or '') clears it, otherwise 0..7200 seconds.
function clean_seconds($value)
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_seconds($value)) {
        fail(400, 'The length must be between 0 and ' . MAX_SECONDS . ' seconds.');
    }
    return $value;
}

// One pad read from the SD card. Fields the app does not know are dropped. A
// length the card reports outside 0..7200 seconds is kept as unknown (null),
// so one damaged pad does not stop the whole import.
function clean_imported_pad($pad, string $project, string $padId): array
{
    $bad = "Project $project, pad $padId is not valid.";
    if (!is_array($pad) || array_is_list($pad) && $pad !== []) {
        fail(400, $bad);
    }
    $name = $pad['name'] ?? '';
    $channels = $pad['channels'] ?? 2;
    $approx = $pad['approx'] ?? false;
    if (!is_string($name) || !in_array($channels, [1, 2], true) || !is_bool($approx)) {
        fail(400, $bad);
    }
    $clean = ['name' => clean_text($name, MAX_NAME)];
    foreach (['playSec', 'fullSec'] as $field) {
        $value = $pad[$field] ?? null;
        if ($value !== null && !is_int($value) && !is_float($value)) {
            fail(400, $bad);
        }
        $clean[$field] = is_seconds($value) ? $value : null;
    }
    $clean['channels'] = $channels;
    $clean['approx'] = $approx;
    return array_intersect_key($clean, array_flip(PAD_FIELDS));
}

function iso_now(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

// One project read from the SD card (ImportedProject in js/importer.js).
function clean_imported_project($project): array
{
    if (!is_array($project)) {
        fail(400, 'A project in this import is not valid.');
    }
    $id = check_project_id($project['id'] ?? null);
    $label = clean_text($id, MAX_NAME);
    $name = $project['name'] ?? '';
    $folder = $project['folder'] ?? '';
    $slot = $project['slot'] ?? null;
    $importedAt = $project['importedAt'] ?? null;
    $pads = $project['pads'] ?? [];
    if (!is_string($name) || !is_string($folder) || !is_array($pads)
        || ($slot !== null && (!is_int($slot) || $slot < 0 || $slot > 999))) {
        fail(400, "Project $label is not valid.");
    }
    if (preg_match('/^slot-(\d+)$/', $id, $m) && $slot === null) {
        $slot = (int) $m[1];
    }
    if (!is_string($importedAt) || !preg_match('/^\d{4}-\d{2}-\d{2}T[0-9:.]{5,15}(Z|[+-]\d{2}:\d{2})$/', $importedAt)) {
        $importedAt = iso_now();
    }
    if (count($pads) > 160) {
        fail(400, "Project $label is not valid.");
    }
    $cleanPads = [];
    foreach ($pads as $padId => $pad) {
        $padId = check_pad_id((string) $padId);
        $cleanPads[$padId] = clean_imported_pad($pad, $label, $padId);
    }
    $name = clean_text($name, MAX_NAME);
    return [
        'id' => $id,
        'name' => $name !== '' ? $name : $label,
        'folder' => clean_text($folder, MAX_FOLDER),
        'source' => 'sd',
        'importedAt' => $importedAt,
        'slot' => $slot,
        'pads' => $cleanPads,
    ];
}

// ── The crate ──

// Every map goes out as a JSON object, even when empty or keyed by numbers.
function crate_out(array $crate): array
{
    $projects = [];
    foreach ($crate['projects'] as $id => $project) {
        $project['pads'] = (object) ($project['pads'] ?? []);
        $projects[(string) $id] = $project;
    }
    $overrides = [];
    foreach ($crate['overrides'] as $id => $pads) {
        $overrides[(string) $id] = (object) $pads;
    }
    return [
        'projects' => (object) $projects,
        'overrides' => (object) $overrides,
        'names' => (object) $crate['names'],
    ];
}

function crate_shape(array &$crate): void
{
    foreach (['projects', 'overrides', 'names'] as $key) {
        if (!is_array($crate[$key] ?? null)) {
            $crate[$key] = [];
        }
    }
}

function read_crate(): array
{
    $crate = store_read('crate');
    crate_shape($crate);
    return $crate;
}

// Change the crate under the lock; returns the new crate and what $change returned.
function update_crate(callable $change): array
{
    return store_update('crate', function (array &$crate) use ($change) {
        crate_shape($crate);
        $result = $change($crate);
        return [$crate, $result];
    });
}

function require_project(array $crate, string $id): void
{
    if (!array_key_exists($id, $crate['projects'])) {
        fail(404, 'That project no longer exists.');
    }
}

// Replaces projects[id] for each imported project. Overrides and names stay.
function import_projects($list): array
{
    if (!is_array($list) || !array_is_list($list)) {
        fail(400, 'The import is not valid.');
    }
    if (count($list) > MAX_PROJECTS) {
        fail(409, 'The crate holds at most ' . MAX_PROJECTS . ' projects.');
    }
    $projects = array_map('clean_imported_project', $list);
    [$crate] = update_crate(function (array &$crate) use ($projects) {
        foreach ($projects as $project) {
            $crate['projects'][$project['id']] = $project;
        }
        // fail() stops before anything is written.
        if (count($crate['projects']) > MAX_PROJECTS) {
            fail(409, 'The crate holds at most ' . MAX_PROJECTS . ' projects. Delete some first.');
        }
    });
    return [$crate, count($projects)];
}

// Same rules as setOverride in js/store.js: a field left out keeps its override,
// name '' or null and playSec null clear that field, an empty override is removed.
// With clear: true the whole override goes (clearOverride).
function set_pad(array $body): array
{
    $projectId = check_project_id($body['projectId'] ?? null);
    $padId = check_pad_id($body['padId'] ?? null);
    $clear = ($body['clear'] ?? false) === true;
    $fields = [];
    if (!$clear) {
        if (array_key_exists('name', $body)) {
            $fields['name'] = clean_name($body['name']);
        }
        if (array_key_exists('playSec', $body)) {
            $fields['playSec'] = clean_seconds($body['playSec']);
        }
    }
    [$crate] = update_crate(function (array &$crate) use ($projectId, $padId, $clear, $fields) {
        require_project($crate, $projectId);
        $projectOverrides = is_array($crate['overrides'][$projectId] ?? null) ? $crate['overrides'][$projectId] : [];
        $entry = is_array($projectOverrides[$padId] ?? null) ? $projectOverrides[$padId] : [];
        if ($clear) {
            $entry = [];
        }
        if (array_key_exists('name', $fields)) {
            if ($fields['name'] === '') {
                unset($entry['name']);
            } else {
                $entry['name'] = $fields['name'];
            }
        }
        if (array_key_exists('playSec', $fields)) {
            if ($fields['playSec'] === null) {
                unset($entry['playSec']);
            } else {
                $entry['playSec'] = $fields['playSec'];
            }
        }
        if ($entry) {
            $projectOverrides[$padId] = $entry;
        } else {
            unset($projectOverrides[$padId]);
        }
        if ($projectOverrides) {
            $crate['overrides'][$projectId] = $projectOverrides;
        } else {
            unset($crate['overrides'][$projectId]);
        }
    });
    return $crate;
}

// Same as addManualProject in js/store.js: id manual-<ms>, empty pads.
function add_project($name): array
{
    $clean = clean_name($name);
    if ($clean === '') {
        $clean = 'Untitled project';
    }
    $now = (int) floor(microtime(true) * 1000);
    return update_crate(function (array &$crate) use ($clean, $now) {
        if (count($crate['projects']) >= MAX_PROJECTS) {
            fail(409, 'The crate holds at most ' . MAX_PROJECTS . ' projects. Delete one first.');
        }
        $id = "manual-$now";
        for ($n = 2; array_key_exists($id, $crate['projects']); $n++) {
            $id = "manual-$now-$n";
        }
        $crate['projects'][$id] = [
            'id' => $id,
            'name' => $clean,
            'folder' => '',
            'source' => 'manual',
            'importedAt' => iso_now(),
            'slot' => null,
            'pads' => [],
        ];
        return $id;
    });
}

// The new name goes in `names`, so reading the card again keeps it.
// An empty name removes the rename and the card's name shows again.
function rename_project(array $body): array
{
    $projectId = check_project_id($body['projectId'] ?? null);
    $name = clean_name($body['name'] ?? null);
    [$crate] = update_crate(function (array &$crate) use ($projectId, $name) {
        require_project($crate, $projectId);
        if ($name === '') {
            unset($crate['names'][$projectId]);
        } else {
            $crate['names'][$projectId] = $name;
        }
    });
    return $crate;
}

function delete_project(array $body): array
{
    $projectId = check_project_id($body['projectId'] ?? null);
    [$crate] = update_crate(function (array &$crate) use ($projectId) {
        unset($crate['projects'][$projectId], $crate['overrides'][$projectId], $crate['names'][$projectId]);
    });
    return $crate;
}

// ── Routing ──

$action = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$reads = ['state', 'list'];
$writes = ['setup', 'login', 'logout', 'import', 'pad', 'project', 'rename', 'delete'];

// A custom header cannot be sent by another site's form or image tag.
if ($method === 'POST' && ($_SERVER['HTTP_X_CRATE'] ?? '') !== '1') {
    fail(400, 'Invalid request.');
}
if (in_array($action, $writes, true)) {
    if ($method !== 'POST') {
        fail(405, 'Invalid request.');
    }
} elseif (in_array($action, $reads, true)) {
    if ($method !== 'GET') {
        fail(405, 'Invalid request.');
    }
} else {
    fail(404, 'Invalid request.');
}

$body = [];
if ($method === 'POST') {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY_BYTES) {
        fail(413, 'That is too much data at once.');
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
    if (strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'That is too much data at once.');
    }
    if (trim($raw) !== '') {
        $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
        if ($type !== 'application/json') {
            fail(415, 'Invalid request.');
        }
        $body = json_decode($raw, true, 64);
        if (!is_array($body) || (array_is_list($body) && $body !== [])) {
            fail(400, 'Invalid request.');
        }
    }
}

$configured = is_file(data_dir() . '/auth.json');

switch ($action) {
    case 'state':
        ok(['setup' => $configured, 'signedIn' => $configured && signed_in()]);

    case 'setup':
        $password = $body['password'] ?? '';
        setup(is_string($password) ? $password : '');
        ok();

    case 'login':
        $password = $body['password'] ?? '';
        login(is_string($password) ? $password : '');
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
        ok(['crate' => crate_out(read_crate())]);

    case 'import':
        [$crate, $count] = import_projects($body['projects'] ?? null);
        ok(['crate' => crate_out($crate), 'imported' => $count]);

    case 'pad':
        ok(['crate' => crate_out(set_pad($body))]);

    case 'project':
        [$crate, $projectId] = add_project($body['name'] ?? null);
        ok(['crate' => crate_out($crate), 'projectId' => $projectId]);

    case 'rename':
        ok(['crate' => crate_out(rename_project($body))]);

    case 'delete':
        ok(['crate' => crate_out(delete_project($body))]);
}
