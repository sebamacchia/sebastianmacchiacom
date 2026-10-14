<?php
// SP404MK2 crate server: one password, the SP-404MKII memory (16 project slots
// with banks and pads) and the index of the SD card (names, lengths and paths
// only; no audio is ever uploaded). Nothing here is secret. The password hash
// and all data live in the data folder, which is created on the server and
// never committed.
//
// crate.json = { memory: {"slot-NN": Slot}, overrides: {"slot-NN": {padId: {name?, playSec?}}},
//                names: {"slot-NN": name}, card: null | {readAt, samples, projects, sx} }
// Slot = {id, slot, name, folder, source: "card"|"manual", loadedAt, pads: {padId: Pad}}
// Pad  = {name, playSec, fullSec, channels, approx, start?, end?}
// The override rules are the same as setOverride/clearOverride in js/store.js, so
// the page can show the crate with those pure functions. A rename lives in
// `names`; loading a card project into a slot clears that slot's overrides and name.

// array_is_list is PHP 8.1+; the hosting's PHP version is not pinned.
if (!function_exists('array_is_list')) {
    function array_is_list(array $array): bool
    {
        return $array === [] || array_keys($array) === range(0, count($array) - 1);
    }
}

const SLOT_COUNT = 16;
const MAX_BODY_BYTES = 2097152; // 2 MB
const MAX_NAME = 80;
const MAX_FOLDER = 255;
const MAX_SECONDS = 7200;       // a length typed by hand, or a pad length from the card
const MAX_SAMPLE_SECONDS = 36000; // a card sample's length
const MAX_PATH = 400;
const MAX_CARD_ID = 300;
const MAX_SAMPLES = 5000;
const MAX_CARD_PROJECTS = 64;
const MAX_SX = 64;
const MAX_OFFSET = 4294967295;  // SMP byte offsets are u32
const MAX_MODIFIED = 4102444800000; // 2100-01-01 in ms
const SAMPLE_EXTS = ['wav', 'aif', 'aiff', 'smp'];
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1000;
const MAX_FAILS = 5;
const LOCK_SECONDS = 900;
const SESSION_SECONDS = 7776000; // 90 days
const COOKIE = 'sp404crate';
const PAD_ID = '/^[A-J]([1-9]|1[0-6])$/';
const SLOT_ID = '/^slot-(0[1-9]|1[0-6])$/';
// Keys the page never copies from data (see UNSAFE_KEYS in js/store.js v2).
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


function has_control_chars(string $value): bool
{
    return (bool) preg_match('/[\p{Cc}\p{Zl}\p{Zp}]/u', $value);
}

function is_number($value): bool
{
    return (is_int($value) || is_float($value)) && is_finite((float) $value);
}

// "slot-07" for 7.
function slot_key(int $slot): string
{
    return sprintf('slot-%02d', $slot);
}

// A slot from the page: 1..16, or "slot-01".."slot-16". Returns the slot number.
function check_slot($value): int
{
    if (is_int($value) && $value >= 1 && $value <= SLOT_COUNT) {
        return $value;
    }
    if (is_string($value) && preg_match(SLOT_ID, $value, $m)) {
        return (int) $m[1];
    }
    fail(400, 'Unknown memory slot.');
}

function check_pad_id($id): string
{
    if (!is_string($id) || !preg_match(PAD_ID, $id)) {
        fail(400, 'Unknown pad.');
    }
    return $id;
}

function is_seconds($value, int $max = MAX_SECONDS): bool
{
    return is_number($value) && $value >= 0 && $value <= $max;
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

function iso_now(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

// ── The card index ──

// A path relative to the card root: 1..400 characters, no ".." part, no
// leading "/", no control characters. It is only ever shown and used as a key
// in the page; the server never opens it.
function is_card_path($path, bool $allowEmpty = false): bool
{
    if (!is_string($path)) {
        return false;
    }
    if ($path === '') {
        return $allowEmpty;
    }
    return mb_strlen($path) <= MAX_PATH
        && $path[0] !== '/'
        && !in_array('..', explode('/', $path), true)
        && !has_control_chars($path);
}

function is_list_of($value, int $max): bool
{
    return is_array($value) && array_is_list($value) && count($value) <= $max;
}

// A map from the page ({} in JSON): an array that is not a non-empty list.
function is_map($value): bool
{
    return is_array($value) && (!array_is_list($value) || $value === []);
}

function clean_card_sample($sample, int $i): array
{
    $bad = 'Sample ' . ($i + 1) . ' in the card index is not valid.';
    if (!is_map($sample) || !is_card_path($sample['path'] ?? null)) {
        fail(400, $bad);
    }
    $path = $sample['path'];
    $ext = $sample['ext'] ?? null;
    $name = $sample['name'] ?? null;
    $sec = $sample['sec'] ?? null;
    if (!is_string($ext) || !in_array(strtolower($ext), SAMPLE_EXTS, true) || !is_string($name)
        || ($sec !== null && !is_seconds($sec, MAX_SAMPLE_SECONDS))) {
        fail(400, $bad);
    }
    $cut = strrpos($path, '/');
    $folder = $cut === false ? '' : substr($path, 0, $cut);
    $name = clean_text($name, MAX_FOLDER);
    if ($name === '') {
        $name = clean_text($cut === false ? $path : substr($path, $cut + 1), MAX_FOLDER);
    }
    return ['path' => $path, 'folder' => $folder, 'name' => $name, 'ext' => strtolower($ext), 'sec' => $sec];
}

// One pad of a card project. A length outside 0..7200 s is kept as unknown
// (null), so one damaged pad does not stop the whole card.
function clean_card_pad($pad, string $label, string $padId): array
{
    $bad = "Project $label, pad $padId is not valid.";
    if (!is_map($pad)) {
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
        if ($value !== null && !is_number($value)) {
            fail(400, $bad);
        }
        $clean[$field] = is_seconds($value) ? $value : null;
    }
    $clean['channels'] = $channels;
    $clean['approx'] = $approx;
    foreach (['start', 'end'] as $field) {
        if (!array_key_exists($field, $pad)) {
            continue;
        }
        $value = $pad[$field];
        if (!is_int($value) || $value < 0 || $value > MAX_OFFSET) {
            fail(400, $bad);
        }
        $clean[$field] = $value;
    }
    return $clean;
}

function clean_card_project($project, int $i): array
{
    $bad = 'Project ' . ($i + 1) . ' in the card index is not valid.';
    if (!is_map($project)) {
        fail(400, $bad);
    }
    $id = $project['id'] ?? null;
    $folder = $project['folder'] ?? null;
    $slot = $project['slot'] ?? null;
    $name = $project['name'] ?? '';
    $modified = $project['modified'] ?? 0;
    $pads = $project['pads'] ?? [];
    if (!is_string($id) || strncmp($id, 'card-', 5) !== 0 || mb_strlen($id) > MAX_CARD_ID || has_control_chars($id)
        || !is_string($folder) || $folder === '' || mb_strlen($folder) > MAX_FOLDER || has_control_chars($folder)
        || strpos($folder, '/') !== false || $folder === '..'
        || ($slot !== null && (!is_int($slot) || $slot < 1 || $slot > SLOT_COUNT))
        || !is_string($name) || !is_number($modified) || $modified < 0 || $modified > MAX_MODIFIED
        || !is_map($pads) || count($pads) > 160) {
        fail(400, $bad);
    }
    $label = clean_text($folder, MAX_NAME);
    $cleanPads = [];
    foreach ($pads as $padId => $pad) {
        $padId = check_pad_id((string) $padId);
        $cleanPads[$padId] = clean_card_pad($pad, $label, $padId);
    }
    $name = clean_text($name, MAX_NAME);
    return [
        'id' => $id,
        'folder' => $folder,
        'slot' => $slot,
        'name' => $name !== '' ? $name : $label,
        'modified' => (int) $modified,
        'pads' => $cleanPads,
    ];
}

function clean_card_sx($sx, int $i): array
{
    $folder = is_map($sx) ? ($sx['folder'] ?? null) : null;
    $name = is_map($sx) ? ($sx['name'] ?? '') : null;
    if (!is_card_path($folder, true) || !is_string($name)) {
        fail(400, 'SP-404SX project ' . ($i + 1) . ' in the card index is not valid.');
    }
    $name = clean_text($name, MAX_NAME);
    return ['folder' => $folder, 'name' => $name !== '' ? $name : clean_text($folder, MAX_NAME)];
}

// The whole card index from readCard() in js/importer.js. Everything is checked
// before anything is written; fields the app does not know are dropped.
function clean_card($card): array
{
    if (!is_map($card) || $card === []) {
        fail(400, 'The card index is not valid.');
    }
    $samples = $card['samples'] ?? [];
    $projects = $card['projects'] ?? [];
    $sx = $card['sx'] ?? [];
    if (!is_list_of($samples, PHP_INT_MAX) || !is_list_of($projects, PHP_INT_MAX) || !is_list_of($sx, PHP_INT_MAX)) {
        fail(400, 'The card index is not valid.');
    }
    if (count($samples) > MAX_SAMPLES) {
        fail(400, 'The card index holds at most ' . MAX_SAMPLES . ' samples.');
    }
    if (count($projects) > MAX_CARD_PROJECTS) {
        fail(400, 'The card index holds at most ' . MAX_CARD_PROJECTS . ' projects.');
    }
    if (count($sx) > MAX_SX) {
        fail(400, 'The card index holds at most ' . MAX_SX . ' SP-404SX projects.');
    }
    $cleanProjects = [];
    $ids = [];
    foreach ($projects as $i => $project) {
        $clean = clean_card_project($project, $i);
        if (isset($ids[$clean['id']])) {
            fail(400, 'Project ' . ($i + 1) . ' in the card index is listed twice.');
        }
        $ids[$clean['id']] = true;
        $cleanProjects[] = $clean;
    }
    $cleanSamples = [];
    foreach ($samples as $i => $sample) {
        $cleanSamples[] = clean_card_sample($sample, $i);
    }
    $cleanSx = [];
    foreach ($sx as $i => $one) {
        $cleanSx[] = clean_card_sx($one, $i);
    }
    return ['readAt' => iso_now(), 'samples' => $cleanSamples, 'projects' => $cleanProjects, 'sx' => $cleanSx];
}

// ── The crate ──

function slot_out(array $entry): array
{
    $entry['pads'] = (object) ($entry['pads'] ?? []);
    return $entry;
}

// Every map goes out as a JSON object, even when empty; every list as an array.
function crate_out(array $crate): array
{
    $memory = [];
    foreach ($crate['memory'] as $id => $entry) {
        $memory[(string) $id] = slot_out($entry);
    }
    $overrides = [];
    foreach ($crate['overrides'] as $id => $pads) {
        $overrides[(string) $id] = (object) $pads;
    }
    $card = null;
    if (is_array($crate['card'])) {
        $card = $crate['card'];
        foreach (['samples', 'projects', 'sx'] as $list) {
            $card[$list] = is_array($card[$list] ?? null) ? array_values($card[$list]) : [];
        }
        $card['projects'] = array_map('slot_out', $card['projects']);
    }
    return [
        'memory' => (object) $memory,
        'overrides' => (object) $overrides,
        'names' => (object) $crate['names'],
        'card' => $card,
    ];
}

// v2 kept `projects`; the slots among them become memory. manual-<ms> and
// folder-named projects are dropped (v3 has only the 16 slots).
function migrate_v2_projects(array $projects): array
{
    $memory = [];
    foreach ($projects as $id => $project) {
        if (!is_array($project) || !preg_match(SLOT_ID, (string) $id, $m)) {
            continue;
        }
        $memory[(string) $id] = [
            'id' => (string) $id,
            'slot' => (int) $m[1],
            'name' => is_string($project['name'] ?? null) ? $project['name'] : '',
            'folder' => is_string($project['folder'] ?? null) ? $project['folder'] : '',
            'source' => ($project['source'] ?? '') === 'manual' ? 'manual' : 'card',
            'loadedAt' => is_string($project['importedAt'] ?? null) ? $project['importedAt'] : iso_now(),
            'pads' => is_array($project['pads'] ?? null) ? $project['pads'] : [],
        ];
    }
    return $memory;
}

// Keep only what v3 knows: slot-01..slot-16 keys and a card index or null.
function crate_shape(array &$crate): void
{
    if (!is_array($crate['memory'] ?? null) && is_array($crate['projects'] ?? null)) {
        $crate['memory'] = migrate_v2_projects($crate['projects']);
    }
    unset($crate['projects']);
    foreach (['memory', 'overrides', 'names'] as $key) {
        $map = is_array($crate[$key] ?? null) ? $crate[$key] : [];
        // memory and overrides hold maps; names holds strings.
        $wantMap = $key !== 'names';
        $crate[$key] = array_filter($map, function ($value, $id) use ($wantMap) {
            return preg_match(SLOT_ID, (string) $id) && ($wantMap ? is_array($value) : is_string($value));
        }, ARRAY_FILTER_USE_BOTH);
    }
    if (!is_array($crate['card'] ?? null)) {
        $crate['card'] = null;
    }
    $crate = array_intersect_key($crate, array_flip(['memory', 'overrides', 'names', 'card']));
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

// Replaces the card index. Memory is never touched.
function save_card($card): array
{
    $clean = clean_card($card);
    [$crate] = update_crate(function (array &$crate) use ($clean) {
        $crate['card'] = $clean;
    });
    return $crate;
}

// Copies a card project into a memory slot, like loading a project on the SP:
// the slot is replaced, so its overrides and its name go too.
function load_project(array $body): array
{
    $projectId = $body['cardProjectId'] ?? null;
    if (!is_string($projectId) || $projectId === '') {
        fail(400, 'Unknown card project.');
    }
    $slot = check_slot($body['slot'] ?? null);
    $key = slot_key($slot);
    [$crate] = update_crate(function (array &$crate) use ($projectId, $slot, $key) {
        $found = null;
        foreach ($crate['card']['projects'] ?? [] as $project) {
            if (($project['id'] ?? null) === $projectId) {
                $found = $project;
                break;
            }
        }
        if ($found === null) {
            fail(404, 'That card project is not in the card index. Read the card again.');
        }
        $crate['memory'][$key] = [
            'id' => $key,
            'slot' => $slot,
            'name' => $found['name'] ?? '',
            'folder' => $found['folder'] ?? '',
            'source' => 'card',
            'loadedAt' => iso_now(),
            'pads' => is_array($found['pads'] ?? null) ? $found['pads'] : [],
        ];
        unset($crate['overrides'][$key], $crate['names'][$key]);
    });
    return $crate;
}

// Same rules as setOverride in js/store.js: a field left out keeps its override,
// name '' or null and playSec null clear that field, an empty override is removed.
// With clear: true the whole override goes (clearOverride). An edit on an empty
// slot creates it as a manual slot; a manual slot left with nothing is removed.
function set_pad(array $body): array
{
    $slot = check_slot($body['slot'] ?? null);
    $key = slot_key($slot);
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
    [$crate] = update_crate(function (array &$crate) use ($slot, $key, $padId, $clear, $fields) {
        $slotOverrides = is_array($crate['overrides'][$key] ?? null) ? $crate['overrides'][$key] : [];
        $entry = is_array($slotOverrides[$padId] ?? null) ? $slotOverrides[$padId] : [];
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
            $slotOverrides[$padId] = $entry;
        } else {
            unset($slotOverrides[$padId]);
        }
        if ($slotOverrides) {
            $crate['overrides'][$key] = $slotOverrides;
        } else {
            unset($crate['overrides'][$key]);
        }

        $memory = $crate['memory'][$key] ?? null;
        if (!is_array($memory) && $slotOverrides) {
            $crate['memory'][$key] = [
                'id' => $key,
                'slot' => $slot,
                'name' => '',
                'folder' => '',
                'source' => 'manual',
                'loadedAt' => iso_now(),
                'pads' => [],
            ];
        } elseif (is_array($memory) && ($memory['source'] ?? '') === 'manual' && !$slotOverrides && empty($memory['pads'])) {
            unset($crate['memory'][$key]);
        }
    });
    return $crate;
}

// The slot's name goes in `names`. An empty name removes it, and the name of
// the loaded project shows again.
function rename_slot(array $body): array
{
    $key = slot_key(check_slot($body['slot'] ?? null));
    $name = clean_name($body['name'] ?? null);
    [$crate] = update_crate(function (array &$crate) use ($key, $name) {
        if ($name === '') {
            unset($crate['names'][$key]);
        } else {
            $crate['names'][$key] = $name;
        }
    });
    return $crate;
}

function clear_slot(array $body): array
{
    $key = slot_key(check_slot($body['slot'] ?? null));
    [$crate] = update_crate(function (array &$crate) use ($key) {
        unset($crate['memory'][$key], $crate['overrides'][$key], $crate['names'][$key]);
    });
    return $crate;
}

// ── Routing ──

$action = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$reads = ['state', 'list'];
$writes = ['setup', 'login', 'logout', 'card', 'load', 'pad', 'rename', 'clear'];

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

    case 'card':
        ok(['crate' => crate_out(save_card($body['card'] ?? null))]);

    case 'load':
        ok(['crate' => crate_out(load_project($body))]);

    case 'pad':
        ok(['crate' => crate_out(set_pad($body))]);

    case 'rename':
        ok(['crate' => crate_out(rename_slot($body))]);

    case 'clear':
        ok(['crate' => crate_out(clear_slot($body))]);
}
