import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../services/db_api.dart';
import '../widgets/offer_card.dart';
import '../widgets/skeleton.dart';
import 'offer_detail.dart';
import 'offres/company_targets.dart';
import 'offres/offers_controller.dart';
import 'offres/widgets/apply_sheet.dart';
import 'offres/widgets/board_tab.dart';
import 'offres/widgets/groups_tab.dart';
import 'offres/widgets/offers_chrome.dart';
import 'offres/widgets/offers_search_bar.dart';
import 'offres/widgets/results_tab.dart';

/// Bottom sheet for moving an offer through the pipeline.
///
/// This is the tap-based replacement for the old drag-and-drop board. Four
/// large rows are far easier to hit than a long-press drag across a
/// horizontally scrolling canvas.
class _StatusSheet extends StatelessWidget {
  const _StatusSheet({required this.current});

  final String current;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 6),
            child: Row(
              children: [
                Text('Changer le statut',
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                        color: scheme.onSurface)),
                const Spacer(),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Fermer'),
                ),
              ],
            ),
          ),
          for (final s in offerStatuses)
            ListTile(
              leading: Icon(offerStatusIcon(s), color: offerStatusColor(s)),
              title: Text(
                offerStatusLabel(s),
                style: TextStyle(
                  fontWeight:
                      s == current ? FontWeight.w800 : FontWeight.w600,
                ),
              ),
              trailing: s == current
                  ? Icon(Icons.check_circle, color: offerStatusColor(s), size: 20)
                  : null,
              selected: s == current,
              onTap: () => Navigator.of(context).pop(s),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// Offres hub: persistent search on top, four tabs below.
///
/// Auto-apply is frozen (see `_dead/verify-freeze.js`): "Postuler" now opens a
/// manual checklist instead of queueing a browser-automation task.
class OffersScreen extends StatefulWidget {
  const OffersScreen({super.key});

  @override
  State<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends State<OffersScreen> {
  final OffersController _controller = OffersController();
  final Set<String> _tailoring = {};

  int _tab = 0;
  bool _relaunching = false;
  Timer? _poll;
  VoidCallback? _openOfferSub;

  /// Wide slice for the group view, which needs breadth, not pages.
  List<Map<String, dynamic>> _broad = [];
  bool _broadLoading = false;
  bool _broadLoaded = false;

  /// Offers the user has opened, served by the server (hasSeen + seen_at).
  List<Map<String, dynamic>> _seen = [];
  bool _seenLoading = false;
  bool _seenLoaded = false;

  @override
  void initState() {
    super.initState();
    _controller.loadFacets();
    _controller.refresh();
    _poll = Timer.periodic(const Duration(seconds: 20), (_) {
      if (!mounted) return;
      // keepLoaded: refresh in place so paged lists are not truncated.
      _controller.refresh(keepLoaded: true);
      if (_broadLoaded) _loadBroad(silent: true, deep: false);
      if (_seenLoaded) _loadSeen(silent: true);
    });
    _openOfferSub = () {
      final id = AppState.openOfferId.value;
      if (id != null) _routeToOffer(id);
    };
    AppState.openOfferRequests.addListener(_openOfferSub!);
    // A tap that landed before this screen existed (cold start) is still queued
    // in AppState, so no notification fires on attach. Read it once here.
    final pending = AppState.openOfferId.value;
    if (pending != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _routeToOffer(pending));
    }
  }

  @override
  void dispose() {
    if (_openOfferSub != null) {
      AppState.openOfferRequests.removeListener(_openOfferSub!);
    }
    _poll?.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// Opens the offer a notification tap asked for.
  ///
  /// Three cases, and none of them may throw: the offer can already be in a
  /// loaded list, it can be on another page or filtered out (the lists are
  /// paginated and the user may have a filter applied), or it can be gone
  /// entirely because it was reaped between the push and the tap.
  Future<void> _routeToOffer(String? id) async {
    if (id == null || id.isEmpty) return;
    // Clear first: this is a one-shot, and a slow fetch must not be replayed by
    // the next poll or by a rebuild.
    if (AppState.openOfferId.value == id) AppState.openOfferId.value = null;

    final local = _findLoaded(id);
    if (local != null) {
      _openDetail(local);
      return;
    }
    try {
      final o = await DbApi.offer(id);
      if (o == null) {
        _toast("Offre introuvable — elle a peut-être été retirée.");
        return;
      }
      if (!mounted) return;
      // The offer was filtered or paged out of view; make sure the user lands on
      // a screen where Back returns to something sensible rather than a list that
      // never contained the card they tapped.
      if (_tab != 0) setState(() => _tab = 0);
      _openDetail(o);
    } catch (_) {
      _toast("Impossible d'ouvrir l'offre.");
    }
  }

  Map<String, dynamic>? _findLoaded(String id) {
    for (final src in <List<Map<String, dynamic>>>[_broad, _seen]) {
      final i = src.indexWhere((o) => (o['id'] ?? '').toString() == id);
      if (i != -1) return src[i];
    }
    return null;
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _loadBroad({bool silent = false, bool deep = true}) async {
    if (_broadLoading) return;
    if (!silent) setState(() => _broadLoading = true);
    final list = await _controller.fetchBroad();
    // The priority countries are loaded in full on top of the broad window:
    // its ordering is by recency, so a country holding more offers than the
    // window would otherwise lose its tail and its group count. Skipped on the
    // background poll, which only needs the window to stay fresh.
    final byId = <String, Map<String, dynamic>>{};
    for (final o in list) {
      byId[(o['id'] ?? '').toString()] = o;
    }
    if (deep) {
      for (final c in priorityCountries) {
        for (final o in await _controller.fetchCountry(c)) {
          byId[(o['id'] ?? '').toString()] = o;
        }
      }
    }
    if (!mounted) return;
    setState(() {
      _broad = byId.values.toList();
      _broadLoading = false;
      _broadLoaded = true;
    });
  }

  Future<void> _loadSeen({bool silent = false}) async {
    if (_seenLoading) return;
    if (!silent) setState(() => _seenLoading = true);
    final list = await _controller.fetchSeen();
    if (!mounted) return;
    setState(() {
      _seen = list;
      _seenLoading = false;
      _seenLoaded = true;
    });
  }

  Future<void> _refreshAll() async {
    await _controller.refresh();
    if (_broadLoaded) await _loadBroad(silent: true);
    if (_seenLoaded) await _loadSeen(silent: true);
  }

  Future<void> _switchTab(int i) async {
    setState(() => _tab = i);
    // Groupes needs the wide slice; Vu needs its own server-side listing.
    if (i == 2 && !_broadLoaded) await _loadBroad();
    if (i == 3 && !_seenLoaded) await _loadSeen();
  }

  Future<void> _relaunchSearch() async {
    if (_relaunching) return;
    setState(() => _relaunching = true);
    try {
      await DbApi.createTask({
        'kind': 'hunt',
        'request': 'nouvelle recherche',
        'status': 'queued',
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content:
                Text('Recherche relancée — les agents scannent les sources.')),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Échec du relancement. Réessaie.')),
      );
    } finally {
      if (mounted) setState(() => _relaunching = false);
    }
  }

  /// Status writes only. Nothing is queued for a browser to submit.
  Future<void> _setStatus(String id, String status, {String ref = ''}) async {
    try {
      // Dedicated route: records statusAt, leaves updated_at alone, so the
      // card keeps showing the real posting age.
      await DbApi.setOfferStatus(id, status);
      final patch = {
        'status': status,
        'statusAt': DateTime.now().toUtc().toIso8601String(),
      };
      _controller.patchItem(id, patch);
      void patchList(List<Map<String, dynamic>> src) {
        final i = src.indexWhere((o) => (o['id'] ?? '').toString() == id);
        if (i != -1) src[i] = {...src[i], ...patch};
      }

      patchList(_broad);
      patchList(_seen);
      if (mounted) setState(() {});
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Mise à jour impossible — API injoignable.')),
      );
    }
  }

  Future<void> _tailor(Map<String, dynamic> o) async {
    final id = (o['id'] ?? '').toString();
    if (_tailoring.contains(id)) return;
    setState(() => _tailoring.add(id));
    final ref = (o['ref'] ?? '').toString();
    final title = (o['title'] ?? '').toString();
    final skin = AppState.cvPro.value ? ' cv pro' : '';
    try {
      await DbApi.sendChat(
        'Adapter documents pour ${ref.isEmpty ? id : ref} $title$skin',
        'user',
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('Adaptation lancée — je te préviens quand c\'est prêt.')),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Adaptation impossible.')));
    } finally {
      if (mounted) setState(() => _tailoring.remove(id));
    }
  }

  void _openDetail(Map<String, dynamic> o) {
    final id = (o['id'] ?? '').toString();
    // Mark it "Vu" without blocking navigation. Fire-and-forget on purpose: a
    // failed write must never stop the user reading the offer. The server keeps
    // the first seenAt, so re-opening does not reset the memory.
    if (id.isNotEmpty && (o['seenAt'] == null)) {
      unawaited(_markSeen(id));
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OfferDetailScreen(
          offer: o,
          id: id,
        ),
      ),
    );
  }

  Future<void> _markSeen(String id) async {
    try {
      await DbApi.markOfferSeen(id);
    } catch (_) {
      // Silent by design.
    }
    if (!mounted) return;
    // Keep the local lists consistent so the unread dot clears at once.
    final stamp = DateTime.now().toUtc().toIso8601String();
    void patch(List<Map<String, dynamic>> src) {
      final i = src.indexWhere((o) => (o['id'] ?? '').toString() == id);
      if (i != -1) src[i] = {...src[i], 'seenAt': stamp};
    }

    patch(_controller.items);
    patch(_broad);
    patch(_seen);
    if (_seenLoaded && !_seen.any((o) => (o['id'] ?? '').toString() == id)) {
      setState(() => _controller.patchItem(id, {'seenAt': stamp}));
    }
  }

  /// Status change from a card or the Vu tab. Writes through the dedicated
  /// status route (keeps updated_at intact) and offers an undo, because a
  /// mis-tap on a phone is likely and the old board had no way back.
  Future<void> _changeStatus(Map<String, dynamic> o) async {
    final id = (o['id'] ?? '').toString();
    final current = (o['status'] ?? 'new').toString();
    final picked = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (ctx) => _StatusSheet(current: current),
    );
    if (picked == null || picked == current || !mounted) return;
    await _setStatus(id, picked, ref: (o['ref'] ?? '').toString());
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text('Statut : ${offerStatusLabel(picked)}'),
        action: SnackBarAction(
          label: 'Annuler',
          onPressed: () => _setStatus(id, current,
              ref: (o['ref'] ?? '').toString()),
        ),
      ));
  }

  /// Manual apply: the 3-step checklist, with the offer link and tailored docs.
  Future<void> _openApply(Map<String, dynamic> o) async {
    final id = (o['id'] ?? '').toString();
    final ref = (o['ref'] ?? id).toString();
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ApplySheet(
        offer: o,
        offerId: id,
        tailoring: _tailoring.contains(id),
        onTailor: () => _tailor(o),
        onMarkApplied: (status) => _setStatus(id, status, ref: ref),
      ),
    );
    if (done == true) await _refreshAll();
  }

  Future<void> _openFilters() async {
    final next = await showModalBottomSheet<OfferFilters>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => OffersFilterSheet(
        initial: _controller.filters,
        facets: _controller.facets,
      ),
    );
    if (next == null) return;
    _controller.applyFilters(next);
    _broadLoaded = false;
    if (_tab >= 2) _loadBroad();
  }

  void _openGroup(String kind, String label, List<Map<String, dynamic>> offers) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => _GroupOffersScreen(
          title: label,
          subtitle: kind == 'company'
              ? '${offers.length} offres'
              : '${offers.length} offres dans ce pays',
          offers: offers,
          tailoring: _tailoring,
          onOpen: _openDetail,
          onApply: (id) => _openApply(
              offers.firstWhere((o) => (o['id'] ?? '').toString() == id)),
          onReject: (id) => _setStatus(id, 'rejected'),
          onTailor: _tailor,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            OffersHero(
              facets: _controller.facets,
              total: _controller.total,
              relaunching: _relaunching,
              onRelaunch: _relaunchSearch,
            ),
            OffersSearchBar(controller: _controller, onOpenFilters: _openFilters),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
              child: OffersTabBar(index: _tab, onChanged: _switchTab),
            ),
            Expanded(child: _body()),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    switch (_tab) {
      case 0:
        return LatestTab(
          controller: _controller,
          tailoring: _tailoring,
          onOpen: _openDetail,
          onApply: (id, _) => _openApply(_offerById(id)),
          onReject: _setStatus,
          onTailor: _tailor,
          onRefresh: _refreshAll,
          onChangeStatus: _changeStatus,
        );
      case 1:
        return ResultsTab(
          controller: _controller,
          tailoring: _tailoring,
          onOpen: _openDetail,
          onApply: (id, _) => _openApply(_offerById(id)),
          onReject: _setStatus,
          onTailor: _tailor,
          onRefresh: _refreshAll,
          onChangeStatus: _changeStatus,
        );
      case 2:
        if (_broadLoading && _broad.isEmpty) {
          return ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 100),
            itemCount: 5,
            itemBuilder: (_, _) => const Padding(
              padding: EdgeInsets.only(bottom: 10),
              child: SkeletonCard(),
            ),
          );
        }
        return GroupsTab(offers: _broad, onOpenGroup: _openGroup);
      default:
        if (_seenLoading && _seen.isEmpty) return const SeenTabSkeleton();
        return SeenTab(
          offers: _seen,
          tailoring: _tailoring,
          onOpen: _openDetail,
          onApply: (id) => _openApply(_offerById(id)),
          onReject: (id) => _setStatus(id, 'rejected'),
          onTailor: _tailor,
          onSetStatus: (id, status) =>
              _changeStatus(_offerById(id)),
          onRefresh: _refreshAll,
        );
    }
  }

  /// Looks an offer up in the paged list first, then the wide and seen slices.
  Map<String, dynamic> _offerById(String id) {
    for (final src in [_controller.items, _broad, _seen]) {
      final i = src.indexWhere((o) => (o['id'] ?? '').toString() == id);
      if (i != -1) return src[i];
    }
    return {'id': id};
  }
}

/// Drill-down list for a company or country group.
class _GroupOffersScreen extends StatelessWidget {
  const _GroupOffersScreen({
    required this.title,
    required this.subtitle,
    required this.offers,
    required this.tailoring,
    required this.onOpen,
    required this.onApply,
    required this.onReject,
    required this.onTailor,
  });

  final String title;
  final String subtitle;
  final List<Map<String, dynamic>> offers;
  final Set<String> tailoring;
  final void Function(Map<String, dynamic> offer) onOpen;
  final void Function(String id) onApply;
  final void Function(String id) onReject;
  final void Function(Map<String, dynamic> offer) onTailor;

  @override
  Widget build(BuildContext context) {
    final sorted = [...offers]..sort((a, b) {
        final r = (offerIsMatch(b) ? 1 : 0).compareTo(offerIsMatch(a) ? 1 : 0);
        if (r != 0) return r;
        return (offerTime(b) ?? DateTime.fromMillisecondsSinceEpoch(0))
            .compareTo(offerTime(a) ?? DateTime.fromMillisecondsSinceEpoch(0));
      });

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: ListView.builder(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 100),
        itemCount: sorted.length + 1,
        itemBuilder: (context, i) {
          if (i == 0) {
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(subtitle,
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: Theme.of(context).colorScheme.onSurfaceVariant)),
            );
          }
          final o = sorted[i - 1];
          final id = (o['id'] ?? '').toString();
          final hasLink = (o['link'] ?? '').toString().isNotEmpty;
          return OfferCard(
            offer: o,
            id: id,
            tailoring: tailoring.contains(id),
            onTap: () => onOpen(o),
            onOpen: hasLink ? () => onOpen(o) : null,
            onApply: () => onApply(id),
            onReject: () => onReject(id),
            onTailor: () => onTailor(o),
          );
        },
      ),
    );
  }
}
