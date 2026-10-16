import 'package:flutter/material.dart';

import '../../../theme/app_theme.dart';
import '../../../utils/company.dart';
import '../../../widgets/offer_card.dart';
import '../company_targets.dart';

/// Grouped browsing: by target company, or by country. Replaces the previous
/// separate 'Entreprises' and 'Pays' tabs.
class GroupsTab extends StatefulWidget {
  const GroupsTab({super.key, required this.offers, required this.onOpenGroup});

  final List<Map<String, dynamic>> offers;
  final void Function(String kind, String label, List<Map<String, dynamic>> offers)
      onOpenGroup;

  @override
  State<GroupsTab> createState() => _GroupsTabState();
}

class _GroupsTabState extends State<GroupsTab> {
  bool _byCompany = true;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
          child: SegmentedButton<bool>(
            segments: const [
              ButtonSegment(
                  value: true,
                  icon: Icon(Icons.business, size: 16),
                  label: Text('Entreprises')),
              ButtonSegment(
                  value: false,
                  icon: Icon(Icons.public, size: 16),
                  label: Text('Pays')),
            ],
            selected: {_byCompany},
            onSelectionChanged: (s) => setState(() => _byCompany = s.first),
            showSelectedIcon: false,
            style: const ButtonStyle(
              visualDensity: VisualDensity.compact,
              textStyle: WidgetStatePropertyAll(
                  TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
            ),
          ),
        ),
        Expanded(
          child: _byCompany
              ? _groupList(_companies())
              : _groupList(_countries()),
        ),
      ],
    );
  }

  Widget _groupList(List<Widget> items) {
    if (items.isEmpty) {
      return Center(
        child: Text('Rien à afficher pour le moment.',
            style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 100),
      children: items,
    );
  }

  List<Widget> _companies() {
    final all = widget.offers;
    final seen = <String>{};
    final pinned = <Widget>[];
    final watch = <({String label, List<Map<String, dynamic>> offers})>[];

    for (final t in companyTargets) {
      final group = all.where((o) {
        final id = (o['id'] ?? '').toString();
        if (id.isNotEmpty && seen.contains(id)) return false;
        final sid = (o['sourceId'] ?? '').toString();
        if (t.sourceIds.contains(sid)) return true;
        final comp = cleanCompany(o['company']).toLowerCase();
        return t.aliases.any(comp.contains);
      }).toList();
      for (final o in group) {
        final id = (o['id'] ?? '').toString();
        if (id.isNotEmpty) seen.add(id);
      }
      if (t.pinned) {
        pinned.add(_groupCard(
          icon: Brand.colorFor(t.label),
          label: t.label,
          offers: group,
          pinned: true,
          onTap: group.isEmpty
              ? null
              : () => widget.onOpenGroup('company', t.label, group),
        ));
      } else if (group.isNotEmpty) {
        watch.add((label: t.label, offers: group));
      }
    }

    watch.sort((a, b) => b.offers.length.compareTo(a.offers.length));

    return [
      _header('Entreprises ciblées',
          'Mes priorités d\'abord, puis celles qui rapportent le plus'),
      ...pinned,
      for (final w in watch.take(20))
        _groupCard(
          icon: Brand.colorFor(w.label),
          label: w.label,
          offers: w.offers,
          onTap: () => widget.onOpenGroup('company', w.label, w.offers),
        ),
    ];
  }

  /// Tunisian areas that count as the capital's commuting belt. Matched as
  /// substrings so the scraped forms ("sfax, sfax, tunisie", "centre ville,
  /// tunis") land in the right bucket whatever order they were captured in.
  static const _grandTunis = <String>[
    'tunis', 'ariana', 'ben arous', 'megrine', 'la marsa', 'manouba',
    'el manar', 'gammarth', 'mornag', 'gritouch', 'carte blanche',
  ];

  /// Location values that place no claim on a region: either absent, or the
  /// posting is explicitly not on site.
  static const _unplaced = <String>['freelance', 'remote', 'a distance', 'teletravail'];

  static const _accented = 'éèêëàâäùûüôöîïçÉÈÊÀÂÇ';
  static const _plain = 'eeeeaaaauuuooiicEEAAAC';

  /// Folds diacritics so "télétravail" and "Mégrine" match the same needle as
  /// their ASCII spelling. The same city arrives both ways in this column
  /// depending on which board captured it.
  static String _fold(String s) {
    final b = StringBuffer();
    for (final ch in s.toLowerCase().split('')) {
      final i = _accented.indexOf(ch);
      b.write(i >= 0 ? _plain[i] : ch);
    }
    return b.toString().trim();
  }

  /// [String.contains] matches on the empty string, so the blank case has to
  /// be an equality test or every offer reads as unplaced.
  static bool _isUnplaced(String loc) {
    final l = _fold(loc);
    if (l.isEmpty) return true;
    return _unplaced.any(l.contains);
  }

  static bool _isGrandTunis(String loc) {
    // Needle 'tunis' is a substring of 'tunisie', so every scraped
    // "... , tunisie" row would land in the capital. Compare per comma- or
    // slash-separated part instead, and skip the bare country name.
    for (final raw in _fold(loc).split(RegExp(r'[,/|]'))) {
      final p = raw.trim();
      if (p.isEmpty || p == 'tunisie') continue;
      if (_grandTunis.any(p.contains)) return true;
    }
    return false;
  }

  List<Widget> _countries() {
    final all = widget.offers;
    final seen = <String>{};
    final out = <Widget>[];
    final groups = <({String label, List<Map<String, dynamic>> offers, bool priority})>[];

    void add(String label, List<Map<String, dynamic>> offers, {bool priority = false}) {
      if (offers.isEmpty) return;
      groups.add((label: label, offers: offers, priority: priority));
      for (final o in offers) {
        final id = (o['id'] ?? '').toString();
        if (id.isNotEmpty) seen.add(id);
      }
    }

    // Tunisie is the home market and holds more postings than the rest of the
    // country list combined, so one flat bucket is neither browsable nor
    // trustworthy. Split it by the area the posting actually names.
    final tn = all.where((o) => offerCountry(o) == 'Tunisie').toList();
    String loc(Map<String, dynamic> o) => (o['location'] ?? '').toString().trim();
    add('Tunisie · Grand Tunis',
        tn.where((o) => !_isUnplaced(loc(o)) && _isGrandTunis(loc(o))).toList(),
        priority: true);
    add('Tunisie · Régions',
        tn.where((o) => !_isUnplaced(loc(o)) && !_isGrandTunis(loc(o))).toList(),
        priority: true);
    add('Tunisie · Localisation non précisée',
        tn.where((o) => _isUnplaced(loc(o))).toList(),
        priority: true);

    for (final c in priorityCountries) {
      if (c == 'Tunisie') continue; // already split by area above
      add(c, all.where((o) => offerCountry(o) == c).toList(), priority: true);
    }
    final rest = all
        .map(offerCountry)
        .where((c) =>
            c.isNotEmpty &&
            c != 'À distance' &&
            c != 'Tunisie' &&
            !priorityCountries.contains(c))
        .toSet()
        .toList()
      ..sort();
    for (final c in rest) {
      add(c, all.where((o) => offerCountry(o) == c).toList());
    }
    add('À distance',
        all.where((o) => offerCountry(o) == 'À distance').toList());

    for (final g in groups) {
      out.add(_groupCard(
        icon: Brand.colorFor(g.label),
        label: g.label,
        offers: g.offers,
        pinned: g.priority,
        flag: true,
        onTap: () => widget.onOpenGroup('country', g.label, g.offers),
      ));
    }
    return [
      _header('Par pays',
          'Tunisie par région, puis les autres pays prioritize'),
      ...out,
    ];
  }

  Widget _header(String title, String subtitle) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 6, 4, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.2)),
          const SizedBox(height: 2),
          Text(subtitle,
              style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }

  Widget _groupCard({
    required Color icon,
    required String label,
    required List<Map<String, dynamic>> offers,
    bool pinned = false,
    bool flag = false,
    VoidCallback? onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final newCount =
        offers.where((o) => (o['status'] ?? 'new').toString() == 'new').length;
    final matchCount = offers.where(offerIsMatch).length;
    Map<String, dynamic>? newest;
    for (final o in offers) {
      if (newest == null) {
        newest = o;
        continue;
      }
      final a = o['updatedAt'] ?? o['postedAt'];
      final b = newest['updatedAt'] ?? newest['postedAt'];
      if (a is String && b is String && a.compareTo(b) > 0) newest = o;
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(13),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(color: icon, borderRadius: BorderRadius.circular(23)),
                child: Icon(flag ? Icons.flag_rounded : Icons.business,
                    color: Colors.white, size: 22),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context)
                                .textTheme
                                .titleSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                        if (pinned) ...[
                          const SizedBox(width: 7),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(
                              color: scheme.secondaryContainer,
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text('Prioritaire',
                                style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    color: scheme.onSecondaryContainer)),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${offers.length} offres · $newCount nouvelle·s'
                      '${matchCount > 0 ? ' · $matchCount match' : ''}',
                      style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSurfaceVariant,
                          fontWeight: FontWeight.w600),
                    ),
                    if (newest != null) ...[
                      const SizedBox(height: 3),
                      Text(
                        '${cleanCompany(newest['company'])} — ${(newest['title'] ?? '').toString()}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(Icons.chevron_right_rounded, color: scheme.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}
