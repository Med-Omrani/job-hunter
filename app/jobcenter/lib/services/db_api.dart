// Docker API Db — replaces lib/services/db.dart Firebase version.
import 'dart:convert';
import 'dart:typed_data';
import 'api_host.dart';

/// One page of server-side search results.
class OfferPage {
  final List<Map<String, dynamic>> items;
  final int total;
  final int offset;
  final bool hasMore;
  const OfferPage({
    required this.items,
    required this.total,
    required this.offset,
    required this.hasMore,
  });
}

/// A filter option plus how many offers carry it.
class FacetValue {
  final String value;
  final int count;
  const FacetValue(this.value, this.count);
}

/// Distinct filter values for the chip rows.
class OfferFacets {
  final List<FacetValue> countries;
  final List<FacetValue> cities;
  final List<FacetValue> contracts;
  final List<FacetValue> sources;

  /// Pipeline counts, so the Suivi header chips never need to pull offers.
  final List<FacetValue> statuses;

  /// How many offers the user has opened ("Vu").
  final int seenTotal;

  const OfferFacets({
    required this.countries,
    required this.cities,
    required this.contracts,
    required this.sources,
    this.statuses = const [],
    this.seenTotal = 0,
  });

  /// Count for one status, 0 when the server has never seen it.
  int statusCount(String status) {
    for (final s in statuses) {
      if (s.value == status) return s.count;
    }
    return 0;
  }
}

class DbApi {
  static Future<List<Map<String, dynamic>>> offers({int limit = 250}) async {
    final res = await ApiHost.get('/api/offers', query: {'limit': '$limit'});
    if (res.statusCode != 200) throw Exception('offers ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  /// A single offer by id. Needed when a notification is tapped for an offer that
  /// is not in the currently loaded page: the offers list is paginated and
  /// filtered, so the tapped card may simply not be in memory. Returns null when
  /// the server has no such offer (404), which happens legitimately -- an offer
  /// can be reaped between the push and the tap.
  static Future<Map<String, dynamic>?> offer(String id) async {
    if (id.isEmpty) return null;
    final res = await ApiHost.get('/api/offers/${Uri.encodeComponent(id)}');
    if (res.statusCode == 404) return null;
    if (res.statusCode != 200) throw Exception('offer ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Server-side offer search. Returns an envelope with the page plus the total
  /// match count, so the app can paginate instead of pulling everything.
  /// [q] is matched as whitespace-separated AND substrings against title,
  /// company, ref, location, contract and description.
  static Future<OfferPage> searchOffers({
    String? q,
    String? status,
    String? sourceId,
    String? country,
    String? city,
    String? contract,
    bool matchOnly = false,
    String? since,
    int limit = 30,
    int offset = 0,
    String sort = 'updated_at',
    bool hasSeen = false,
    bool listFields = true,
  }) async {
    final query = <String, String>{'limit': '$limit', 'offset': '$offset', 'sort': sort};
    void put(String k, String? v) {
      if (v != null && v.isNotEmpty) query[k] = v;
    }

    // Ask the server to drop `description` from the rows themselves. The offers
    // table is 239MB, of which 93MB is description text (avg 3.2KB/offer), but
    // no list widget ever reads it -- offer_card.dart reads only
    // country/keywords/location/match/score/seenAt/statusAt. Measured:
    // 30 rows 140KB -> 24KB, 200 rows 1.0MB -> 164KB. The detail screen fetches
    // the body per offer from /api/offers/:id, which is unchanged.
    //
    // Set listFields:false for a caller that genuinely needs the full text.
    if (listFields) query['fields'] = 'list';

    put('q', q);
    put('status', status);
    put('sourceId', sourceId);
    put('country', country);
    put('city', city);
    put('contract', contract);
    put('since', since);
    if (matchOnly) query['matchOnly'] = '1';
    if (hasSeen) query['hasSeen'] = '1';

    final res = await ApiHost.get('/api/offers/search', query: query);
    if (res.statusCode != 200) throw Exception('offers/search ${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return OfferPage(
      items: (body['items'] as List).cast<Map<String, dynamic>>(),
      total: (body['total'] as num?)?.toInt() ?? 0,
      offset: (body['offset'] as num?)?.toInt() ?? 0,
      hasMore: body['hasMore'] == true,
    );
  }

  /// Distinct filter values with counts, so the chip rows never require
  /// downloading the whole offer list.
  static Future<OfferFacets> offerFacets() async {
    final res = await ApiHost.get('/api/offers/facets');
    if (res.statusCode != 200) throw Exception('facets ${res.statusCode}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    List<FacetValue> pick(String key) => ((body[key] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map((e) => FacetValue(
              (e['value'] ?? '').toString(),
              (e['count'] as num?)?.toInt() ?? 0,
            ))
        .where((e) => e.value.isNotEmpty)
        .toList();
    return OfferFacets(
      countries: pick('countries'),
      cities: pick('cities'),
      contracts: pick('contracts'),
      sources: pick('sources'),
      statuses: pick('statuses'),
      seenTotal: (body['seenTotal'] as num?)?.toInt() ?? 0,
    );
  }

  static Future<List<Map<String, dynamic>>> docs() async {
    final res = await ApiHost.get('/api/docs');
    if (res.statusCode != 200) throw Exception('docs ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  static Future<List<Map<String, dynamic>>> sources() async {
    final res = await ApiHost.get('/api/sources');
    if (res.statusCode != 200) throw Exception('sources ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>> createSource(Map<String, dynamic> data) async {
    final res = await ApiHost.post('/api/sources', data);
    if (res.statusCode != 200 && res.statusCode != 201) throw Exception('createSource ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  static Future<Map<String, dynamic>> profile() async {
    final res = await ApiHost.get('/api/profile');
    if (res.statusCode != 200) throw Exception('profile ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  static Future<void> updateProfile(Map<String, dynamic> data) async {
    final res = await ApiHost.put('/api/profile', data);
    if (res.statusCode != 200) throw Exception('put profile ${res.statusCode}');
  }

  static Future<List<Map<String, dynamic>>> chatMessages({int limit = 200, String channel = 'main'}) async {
    final res = await ApiHost.get('/api/chat/messages', query: {'limit': '$limit', 'channel': channel});
    if (res.statusCode != 200) throw Exception('chat ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  static Future<void> sendChat(String text, String sender, {String channel = 'main', String? replyTo}) async {
    final res = await ApiHost.post('/api/chat/messages', {
      'text': text, 'sender': sender, 'channel': channel,
      'replyTo': ?replyTo,
    });
    if (res.statusCode != 200 && res.statusCode != 201) throw Exception('sendChat ${res.statusCode}');
  }

  static Future<void> saveFcmToken(String token) async {
    final res = await ApiHost.post('/api/devices', {'id': 'android', 'token': token, 'platform': 'android'});
    if (res.statusCode != 200) throw Exception('save token ${res.statusCode}');
  }

  static Future<void> updateOffer(String id, Map<String, dynamic> patch) async {
    final res = await ApiHost.patch('/api/offers/$id', patch);
    if (res.statusCode != 200) throw Exception('updateOffer ${res.statusCode}');
  }

  /// Writes the pipeline status through the dedicated route, which records
  /// statusAt and deliberately leaves updated_at alone. Using the generic
  /// [updateOffer] here would reset every card's age to "now".
  static Future<void> setOfferStatus(String id, String status) async {
    final res =
        await ApiHost.patch('/api/offers/$id/status', {'status': status});
    if (res.statusCode != 200) throw Exception('setOfferStatus ${res.statusCode}');
  }

  /// Marks an offer as opened ("Vu"). Fire-and-forget: the server keeps the
  /// first seenAt, so re-reading a posting never erases the memory of it, and
  /// a failure here must never block opening the offer.
  static Future<void> markOfferSeen(String id) async {
    final res = await ApiHost.post('/api/offers/$id/seen', {});
    if (res.statusCode != 200) throw Exception('markOfferSeen ${res.statusCode}');
  }

  static Future<void> updateSource(String id, Map<String, dynamic> patch) async {
    final res = await ApiHost.patch('/api/sources/$id', patch);
    if (res.statusCode != 200) throw Exception('updateSource ${res.statusCode}');
  }

  static Future<void> deleteDoc(String id) async {
    final res = await ApiHost.del('/api/docs/$id');
    if (res.statusCode != 200) throw Exception('deleteDoc ${res.statusCode}');
  }

  /// Raw PDF bytes for a doc (served from the PC pdf volume).
  static Future<Uint8List> pdfBytes(String id) async {
    final res = await ApiHost.get('/api/docs/$id/pdf');
    if (res.statusCode != 200) throw Exception('pdf ${res.statusCode}');
    return res.bodyBytes;
  }

  static Future<Map<String, dynamic>> agentStatus() async {
    final res = await ApiHost.get('/api/agent/status');
    if (res.statusCode != 200) throw Exception('agent ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  static Future<List<Map<String, dynamic>>> tasks({String? status, int limit = 25}) async {
    final q = <String, String>{'limit': '$limit'};
    if (status != null) q['status'] = status;
    final res = await ApiHost.get('/api/tasks', query: q);
    if (res.statusCode != 200) throw Exception('tasks ${res.statusCode}');
    return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>> createTask(Map<String, dynamic> data) async {
    final res = await ApiHost.post('/api/tasks', data);
    if (res.statusCode != 200 && res.statusCode != 201) throw Exception('createTask ${res.statusCode}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }
}
