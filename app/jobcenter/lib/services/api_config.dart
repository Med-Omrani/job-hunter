import 'dart:async';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class ApiConfig {
  static const _key = 'api_base_url';
  static const _storage = FlutterSecureStorage();
  static String? _cached;

  // WHY A CANDIDATE LIST INSTEAD OF ONE HARD-CODED HOST
  // A baked-in host is correct on exactly one network topology. Verified on a
  // real device: a VPN address (e.g. Tailscale) timed out while the plain LAN
  // address connected fine, so the app would show a blank screen with no error.
  //
  // So the host is discovered, not assumed. Probed in order and the first one
  // that answers /api/health wins; a --dart-define or a user-set URL still wins
  // outright, because an explicit choice must never be second-guessed.
  static const String defaultUrl = 'http://10.0.2.2:8081';
  static const List<String> fallbackUrls = [
    'http://10.0.2.2:8081', // Android emulator's alias for the host machine
    'http://127.0.0.1:8081',
    'http://localhost:8081',
  ];

  static const Duration _probeTimeout = Duration(seconds: 4);

  static Future<bool> _healthy(String base) async {
    try {
      final res = await http
          .get(Uri.parse('$base/api/health'))
          .timeout(_probeTimeout);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static String _clean(String url) => url.trim().replaceAll(RegExp(r'/$'), '');

  static Future<String> get() async {
    if (_cached != null) return _cached!;

    // 1. Explicit build-time override always wins, no probing.
    const fromEnv = String.fromEnvironment('API_BASE_URL', defaultValue: '');
    if (fromEnv.isNotEmpty) return _cached = _clean(fromEnv);

    // 2. A URL the user set in Settings is an explicit choice too.
    final stored = await _storage.read(key: _key);
    if (stored != null && stored.trim().isNotEmpty) {
      return _cached = _clean(stored);
    }

    // 3. Otherwise discover. Try every candidate and keep the first that answers.
    for (final c in [defaultUrl, ...fallbackUrls]) {
      if (await _healthy(c)) return _cached = _clean(c);
    }

    // 4. Nothing answered. Return the historical default so the UI has something
    //    to show and fails visibly, rather than throwing during startup.
    return _cached = defaultUrl;
  }

  static Future<String> getSync() async => await get();

  static Future<void> set(String url) async {
    final v = _clean(url);
    _cached = v.isEmpty ? defaultUrl : v;
    if (v.isEmpty) {
      await _storage.delete(key: _key);
    } else {
      await _storage.write(key: _key, value: _cached!);
    }
  }

  static Future<void> clear() async {
    _cached = null;
    await _storage.delete(key: _key);
  }
}
