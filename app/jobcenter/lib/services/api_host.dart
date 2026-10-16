import 'dart:convert';
import 'package:http/http.dart' as http;

import 'api_config.dart';

/// Docker API host — replaces FirebaseHost + Db for the new stack.
/// The PC runs `docker compose` at http://<pc-ip>:8081 (nginx) or https://<tunnel>.
/// Phone sets API_BASE_URL via --dart-define or runtime Settings (stored).
class ApiHost {
  ApiHost._();
  static String _overrideUrl = '';
  static String? _token;
  static String _tokenUrl = '';

  static Future<String> get baseUrl async {
    if (_overrideUrl.isNotEmpty) return _overrideUrl;
    const fromEnv = String.fromEnvironment('API_BASE_URL', defaultValue: '');
    if (fromEnv.isNotEmpty) return fromEnv.replaceAll(RegExp(r'/$'), '');
    return await ApiConfig.get();
  }

  static String get baseUrlSync {
    if (_overrideUrl.isNotEmpty) return _overrideUrl;
    const fromEnv = String.fromEnvironment('API_BASE_URL', defaultValue: '');
    if (fromEnv.isNotEmpty) return fromEnv.replaceAll(RegExp(r'/$'), '');
    return ApiConfig.defaultUrl;
  }

  static Future<void> setBaseUrl(String url) async {
    _overrideUrl = url.trim().replaceAll(RegExp(r'/$'), '');
    _token = null;
    _tokenUrl = '';
    await ApiConfig.set(_overrideUrl);
  }

  static Future<String> getToken() async {
    final base = await baseUrl;
    if (_token != null && _tokenUrl == base) return _token!;
    final res = await http.post(
      Uri.parse('$base/api/auth/anon'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'uid': 'flutter-app'}),
    );
    if (res.statusCode != 200) throw Exception('auth anon failed ${res.statusCode} on $base');
    final j = jsonDecode(res.body) as Map;
    _token = j['token'] as String;
    _tokenUrl = base;
    return _token!;
  }

  static Future<Map<String, String>> authHeaders() async {
    final t = await getToken();
    return {'Content-Type': 'application/json', 'Authorization': 'Bearer $t'};
  }

  static Future<http.Response> get(String path, {Map<String, String>? query}) async {
    final base = await baseUrl;
    final uri = Uri.parse('$base$path').replace(queryParameters: query);
    final h = await authHeaders();
    return http.get(uri, headers: h);
  }

  static Future<http.Response> post(String path, Object body) async {
    final base = await baseUrl;
    final h = await authHeaders();
    return http.post(Uri.parse('$base$path'), headers: h, body: jsonEncode(body));
  }

  static Future<http.Response> patch(String path, Object body) async {
    final base = await baseUrl;
    final h = await authHeaders();
    return http.patch(Uri.parse('$base$path'), headers: h, body: jsonEncode(body));
  }

  static Future<http.Response> put(String path, Object body) async {
    final base = await baseUrl;
    final h = await authHeaders();
    return http.put(Uri.parse('$base$path'), headers: h, body: jsonEncode(body));
  }

  static Future<http.Response> del(String path) async {
    final base = await baseUrl;
    final h = await authHeaders();
    return http.delete(Uri.parse('$base$path'), headers: h);
  }

  static Future<bool> test(String url) async {
    try {
      final base = url.trim().replaceAll(RegExp(r'/$'), '');
      final res = await http.get(Uri.parse('$base/api/health')).timeout(const Duration(seconds: 8));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
