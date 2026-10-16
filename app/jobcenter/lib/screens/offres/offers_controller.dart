import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../../services/db_api.dart';

/// Active filter state for the offers screen. Immutable so the controller can
/// diff two snapshots and skip redundant requests.
class OfferFilters {
  final String query;
  final String? status;
  final String? country;
  final String? city;
  final String? contract;
  final String? sourceId;
  final String? dateFilter;
  final bool matchOnly;
  final bool hideStale;

  const OfferFilters({
    this.query = '',
    this.status,
    this.country,
    this.city,
    this.contract,
    this.sourceId,
    this.dateFilter,
    this.matchOnly = false,
    this.hideStale = false,
  });

  int get activeCount =>
      (query.isNotEmpty ? 1 : 0) +
      (status != null ? 1 : 0) +
      (country != null ? 1 : 0) +
      (city != null ? 1 : 0) +
      (contract != null ? 1 : 0) +
      (sourceId != null ? 1 : 0) +
      (dateFilter != null ? 1 : 0) +
      (matchOnly ? 1 : 0) +
      (hideStale ? 1 : 0);

  bool get isFiltering => activeCount > 0;

  DateTime? get cutoff {
    final f = dateFilter;
    if (f == null) return null;
    const mins = {
      '30m': 30,
      '1h': 60,
      '5h': 300,
      '24h': 1440,
      '3d': 4320,
      '7d': 10080,
      '30d': 43200,
    };
    final m = mins[f];
    if (m == null) return null;
    return DateTime.now().subtract(Duration(minutes: m));
  }

  OfferFilters copyWith({
    String? query,
    String? status,
    String? country,
    String? city,
    String? contract,
    String? sourceId,
    String? dateFilter,
    bool? matchOnly,
    bool? hideStale,
    bool clearStatus = false,
    bool clearCountry = false,
    bool clearCity = false,
    bool clearContract = false,
    bool clearSource = false,
    bool clearDate = false,
  }) {
    return OfferFilters(
      query: query ?? this.query,
      status: clearStatus ? null : (status ?? this.status),
      country: clearCountry ? null : (country ?? this.country),
      city: clearCity ? null : (city ?? this.city),
      contract: clearContract ? null : (contract ?? this.contract),
      sourceId: clearSource ? null : (sourceId ?? this.sourceId),
      dateFilter: clearDate ? null : (dateFilter ?? this.dateFilter),
      matchOnly: matchOnly ?? this.matchOnly,
      hideStale: hideStale ?? this.hideStale,
    );
  }

  static const empty = OfferFilters();
}

/// Drives server-side offer search: debounced querying, pagination and facets.
class OffersController extends ChangeNotifier {
  static const pageSize = 30;

  /// Mirrors the server-side cap on /api/offers/search.
  static const maxWindow = 200;

  static const _debounce = Duration(milliseconds: 300);

  OfferFilters _filters = OfferFilters.empty;
  List<Map<String, dynamic>> _items = [];
  OfferFacets _facets = const OfferFacets(
    countries: [],
    cities: [],
    contracts: [],
    sources: [],
  );

  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasMore = false;
  String? _error;

  Timer? _debounceTimer;
  int _requestSeq = 0;

  OfferFilters get filters => _filters;
  List<Map<String, dynamic>> get items => _items;
  OfferFacets get facets => _facets;
  int get total => _total;
  bool get loading => _loading;
  bool get loadingMore => _loadingMore;
  bool get hasMore => _hasMore;
  String? get error => _error;

  /// The subset that still needs client-side work after the server query.
  List<Map<String, dynamic>> get visibleItems {
    final cutoff = _filters.cutoff;
    final hideStale = _filters.hideStale;
    if (cutoff == null && !hideStale) return _items;
    final staleCutoff = DateTime.now().subtract(const Duration(days: 14));
    return _items.where((o) {
      if (cutoff != null) {
        final t = _timeOf(o);
        if (t == null || t.isBefore(cutoff)) return false;
      }
      if (hideStale && (o['status'] ?? 'new').toString() == 'new') {
        final t = _timeOf(o);
        if (t != null && t.isBefore(staleCutoff)) return false;
      }
      return true;
    }).toList();
  }

  static DateTime? _timeOf(Map<String, dynamic> o) {
    for (final k in ['postedAt', 'posted', 'updatedAt']) {
      final v = o[k];
      if (v is DateTime) return v;
      if (v is String) {
        final d = DateTime.tryParse(v);
        if (d != null) return d;
      }
    }
    return null;
  }

  void setQuery(String q) {
    final next = _filters.copyWith(query: q.trim());
    if (next.query == _filters.query) return;
    _filters = next;
    _debounceTimer?.cancel();
    _debounceTimer = Timer(_debounce, () => refresh());
    notifyListeners();
  }

  /// Apply a whole new filter set (from the filter sheet).
  void applyFilters(OfferFilters next) {
    _filters = next;
    refresh();
  }

  void setSource(String? sid) {
    if (sid == null) {
      if (_filters.sourceId == null) return;
      _filters = _filters.copyWith(clearSource: true);
    } else {
      if (_filters.sourceId == sid) return;
      _filters = _filters.copyWith(sourceId: sid);
    }
    refresh();
  }

  void toggleHideStale() {
    _filters = _filters.copyWith(hideStale: !_filters.hideStale);
    notifyListeners();
  }

  void reset() {
    _debounceTimer?.cancel();
    _filters = OfferFilters.empty;
    refresh();
  }

  Future<void> loadFacets() async {
    try {
      _facets = await DbApi.offerFacets();
      notifyListeners();
    } catch (_) {
      // Facets are an enhancement; chips simply stay unpopulated.
    }
  }

  /// Single place where filter state turns into a server query, so paging and
  /// the wide group/board fetch can never drift apart.
  Future<OfferPage> _runSearch({required int limit, required int offset}) {
    final f = _filters;
    return DbApi.searchOffers(
      q: f.query,
      status: f.status,
      sourceId: f.sourceId,
      country: f.country,
      city: f.city,
      contract: f.contract,
      matchOnly: f.matchOnly,
      since: f.dateFilter != null ? f.cutoff?.toUtc().toIso8601String() : null,
      limit: limit,
      offset: offset,
    );
  }

  /// Reloads from the first page.
  ///
  /// [keepLoaded] refetches the same window the user already scrolled through,
  /// so background polling never truncates a paged list. The server caps a
  /// single request at 200 rows, which is where the window tops out.
  Future<void> refresh({bool keepLoaded = false}) async {
    final seq = ++_requestSeq;
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final window = keepLoaded
          ? _items.length.clamp(pageSize, maxWindow)
          : pageSize;
      final page = await _runSearch(limit: window, offset: 0);
      if (seq != _requestSeq) return;
      _items = page.items;
      _total = page.total;
      _hasMore = page.hasMore;
    } catch (e) {
      if (seq != _requestSeq) return;
      _error = 'Recherche indisponible';
      _items = [];
      _total = 0;
      _hasMore = false;
    } finally {
      if (seq == _requestSeq) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> loadMore() async {
    if (_loadingMore || !_hasMore || _loading) return;
    _loadingMore = true;
    notifyListeners();
    try {
      final page = await _runSearch(limit: pageSize, offset: _items.length);
      _items = [..._items, ...page.items];
      _hasMore = page.hasMore;
    } catch (_) {
      _hasMore = false;
    } finally {
      _loadingMore = false;
      notifyListeners();
    }
  }

  /// Wide fetch for the group and board views, which need breadth rather than
  /// pages. The server caps a single request at [maxWindow], so passing a
  /// larger [limit] used to come back silently truncated to the first page -
  /// which is why the country groups were built from 200 of 11k offers.
  /// Walks the pagination instead, so the counts on the cards are real.
  Future<List<Map<String, dynamic>>> fetchBroad({int limit = 500}) async {
    return _pagedSearch(limit: limit);
  }

  /// Every offer for one country, past the per-request cap.
  ///
  /// Needed because the broad window is ordered by recency: a country with more
  /// postings than [limit] loses its tail entirely, and the Tunisie groups are
  /// built from exactly that kind of bulk.
  Future<List<Map<String, dynamic>>> fetchCountry(String country,
      {int limit = 1200}) async {
    return _pagedSearch(limit: limit, country: country);
  }

  /// Collects up to [limit] offers by repeatedly asking for one capped page.
  /// Stops on the first empty page, when the server reports no more rows, or
  /// when [limit] is reached. Network errors keep whatever was already
  /// collected rather than throwing away a partially built group.
  Future<List<Map<String, dynamic>>> _pagedSearch(
      {required int limit, String? country}) async {
    final out = <Map<String, dynamic>>[];
    final seen = <String>{};
    var offset = 0;
    while (out.length < limit) {
      final page = await _page(
        country: country,
        offset: offset,
        want: limit - out.length,
      );
      if (page == null || page.items.isEmpty) break;
      for (final o in page.items) {
        final id = (o['id'] ?? '').toString();
        if (id.isNotEmpty && !seen.add(id)) continue;
        out.add(o);
      }
      if (!page.hasMore) break;
      offset += page.items.length;
    }
    return out;
  }

  /// One capped page for the group fetches. [country] overrides the active
  /// country filter so a single country can be loaded in full while browsing.
  Future<OfferPage?> _page(
      {String? country, required int offset, required int want}) async {
    final f = _filters;
    try {
      return await DbApi.searchOffers(
        q: f.query,
        status: f.status,
        sourceId: f.sourceId,
        country: country ?? f.country,
        city: f.city,
        contract: f.contract,
        matchOnly: f.matchOnly,
        since: f.dateFilter != null
            ? f.cutoff?.toUtc().toIso8601String()
            : null,
        limit: math.min(maxWindow, want),
        offset: offset,
      );
    } catch (_) {
      return null;
    }
  }

  /// Offers the user has actually opened, newest opening first.
  ///
  /// Served by the server (hasSeen + sort=seen_at), so this stays correct no
  /// matter how many offers exist and is never silently truncated the way the
  /// old board's 500-row fetch was (the API caps a page at 200).
  Future<List<Map<String, dynamic>>> fetchSeen({int limit = 200}) async {
    try {
      final page = await DbApi.searchOffers(
        hasSeen: true,
        sort: 'seen_at',
        limit: limit,
      );
      return page.items;
    } catch (_) {
      return const [];
    }
  }

  /// Replace one offer in place after a status change, without a refetch.
  void patchItem(String id, Map<String, dynamic> patch) {
    final i = _items.indexWhere((o) => (o['id'] ?? '').toString() == id);
    if (i == -1) return;
    _items = [..._items]..[i] = {..._items[i], ...patch};
    notifyListeners();
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    super.dispose();
  }
}
