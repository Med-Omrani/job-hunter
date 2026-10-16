import 'package:flutter/material.dart';

import '../../../services/db_api.dart';
import '../company_targets.dart';
import '../offers_controller.dart';

/// Search field + filter button + active-filter chips. Lives above the tab row
/// so it is reachable from every tab (previously it only existed on 'Toutes').
class OffersSearchBar extends StatefulWidget {
  const OffersSearchBar({
    super.key,
    required this.controller,
    required this.onOpenFilters,
  });

  final OffersController controller;
  final VoidCallback onOpenFilters;

  @override
  State<OffersSearchBar> createState() => _OffersSearchBarState();
}

class _OffersSearchBarState extends State<OffersSearchBar> {
  late final TextEditingController _text;

  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: widget.controller.filters.query);
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _sync(String q) {
    if (_text.text == q) return;
    _text.value = TextEditingValue(
      text: q,
      selection: TextSelection.collapsed(offset: q.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final f = widget.controller.filters;
        _sync(f.query);
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _text,
                      onChanged: widget.controller.setQuery,
                      textInputAction: TextInputAction.search,
                      decoration: InputDecoration(
                        hintText: 'Rechercher (titre, société, réf…)',
                        prefixIcon: const Icon(Icons.search, size: 20),
                        suffixIcon: f.query.isEmpty
                            ? null
                            : IconButton(
                                icon: const Icon(Icons.close, size: 18),
                                tooltip: 'Effacer',
                                onPressed: () {
                                  _text.clear();
                                  widget.controller.setQuery('');
                                },
                              ),
                        isDense: true,
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14)),
                        contentPadding:
                            const EdgeInsets.symmetric(vertical: 11),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Badge(
                    isLabelVisible: f.activeCount > 0,
                    label: Text('${f.activeCount}'),
                    child: FilledButton.tonalIcon(
                      onPressed: widget.onOpenFilters,
                      icon: const Icon(Icons.tune, size: 18),
                      label: const Text('Filtres'),
                    ),
                  ),
                  if (f.activeCount > 0)
                    IconButton(
                      onPressed: widget.controller.reset,
                      tooltip: 'Réinitialiser',
                      icon: const Icon(Icons.filter_alt_off),
                    ),
                ],
              ),
            ),
            if (f.activeCount > 0) _activeChips(context, f),
          ],
        );
      },
    );
  }

  Widget _activeChips(BuildContext context, OfferFilters f) {
    final c = widget.controller;
    final chips = <(String, IconData, VoidCallback)>[];
    if (f.status != null) {
      chips.add(('Statut : ${_statusLabel(f.status!)}', Icons.flag_outlined, () {
        c.applyFilters(f.copyWith(clearStatus: true));
      }));
    }
    if (f.country != null) {
      chips.add((f.country!, Icons.public, () {
        c.applyFilters(f.copyWith(clearCountry: true));
      }));
    }
    if (f.city != null) {
      chips.add((f.city!, Icons.place_outlined, () {
        c.applyFilters(f.copyWith(clearCity: true));
      }));
    }
    if (f.contract != null) {
      chips.add((f.contract!, Icons.badge_outlined, () {
        c.applyFilters(f.copyWith(clearContract: true));
      }));
    }
    if (f.sourceId != null) {
      chips.add((sourceLabel(f.sourceId!), Icons.rss_feed, () {
        c.setSource(null);
      }));
    }
    if (f.dateFilter != null) {
      chips.add(('Dernières ${_dateLabel(f.dateFilter!)}', Icons.schedule,
          () => c.applyFilters(f.copyWith(clearDate: true))));
    }
    if (f.matchOnly) {
      chips.add(('Correspond', Icons.check_circle_outline,
          () => c.applyFilters(f.copyWith(matchOnly: false))));
    }
    if (f.hideStale) {
      chips.add(('Fraîches', Icons.auto_delete_outlined,
          () => c.toggleHideStale()));
    }

    return SizedBox(
      height: 34,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: chips.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, i) {
          final (label, icon, onTap) = chips[i];
          return InputChip(
            label: Text(label,
                style: const TextStyle(
                    fontSize: 11.5, fontWeight: FontWeight.w700)),
            avatar: Icon(icon, size: 14),
            onDeleted: onTap,
            onPressed: onTap,
            deleteIcon: const Icon(Icons.close, size: 14),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          );
        },
      ),
    );
  }

  static String _statusLabel(String s) => switch (s) {
        'new' => 'Nouvelle',
        'to_apply' => 'À postuler',
        'applied' => 'Postulée',
        'rejected' => 'Refusée',
        _ => s,
      };

  static String _dateLabel(String f) => switch (f) {
        '30m' => '30 min',
        '1h' => '1 h',
        '5h' => '5 h',
        '24h' => '24 h',
        '3d' => '3 j',
        '7d' => '7 j',
        '30d' => '30 j',
        _ => f,
      };
}

/// Bottom sheet with the full filter set. Counts come from the server facets.
class OffersFilterSheet extends StatefulWidget {
  const OffersFilterSheet({super.key, required this.initial, required this.facets});

  final OfferFilters initial;
  final OfferFacets facets;

  @override
  State<OffersFilterSheet> createState() => _OffersFilterSheetState();
}

class _OffersFilterSheetState extends State<OffersFilterSheet> {
  late OfferFilters _f = widget.initial;
  late final TextEditingController _q =
      TextEditingController(text: widget.initial.query);

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fac = widget.facets;
    return SafeArea(
      top: false,
      child: Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 10,
          bottom: 16 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('Filtres',
                      style: Theme.of(context)
                          .textTheme
                          .titleLarge
                          ?.copyWith(fontWeight: FontWeight.w800)),
                  const Spacer(),
                  TextButton(
                    onPressed: () => setState(() {
                      _f = OfferFilters.empty;
                      _q.clear();
                    }),
                    child: const Text('Tout effacer'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _q,
                onChanged: (v) => setState(() => _f = _f.copyWith(query: v)),
                decoration: InputDecoration(
                  hintText: 'Rechercher (titre, société, réf…)',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14)),
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: const Text('Masquer les offres « Nouvelle » immergées',
                    style:
                        TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                subtitle: const Text('Plus de 14 jours sans suivi',
                    style: TextStyle(fontSize: 11)),
                value: _f.hideStale,
                onChanged: (v) => setState(() => _f = _f.copyWith(hideStale: v)),
              ),
              _chipRow('Statut', [
                ('Toutes', _f.status == null,
                    () => setState(() => _f = _f.copyWith(clearStatus: true))),
                ('Nouvelle', _f.status == 'new',
                    () => setState(() => _f = _f.copyWith(status: 'new'))),
                ('À postuler', _f.status == 'to_apply',
                    () => setState(() => _f = _f.copyWith(status: 'to_apply'))),
                ('Postulée', _f.status == 'applied',
                    () => setState(() => _f = _f.copyWith(status: 'applied'))),
                ('Refusée', _f.status == 'rejected',
                    () => setState(() => _f = _f.copyWith(status: 'rejected'))),
              ]),
              if (fac.sources.isNotEmpty)
                _facetRow('Source', fac.sources, _f.sourceId,
                    (v) => setState(() => v == null
                        ? _f = _f.copyWith(clearSource: true)
                        : _f = _f.copyWith(sourceId: v))),
              if (fac.countries.isNotEmpty)
                _facetRow('Pays', fac.countries, _f.country, (v) => setState(
                    () => v == null
                        ? _f = _f.copyWith(clearCountry: true)
                        : _f = _f.copyWith(country: v))),
              if (fac.cities.isNotEmpty)
                _facetRow('Lieu', fac.cities, _f.city,
                    (v) => setState(() => v == null
                        ? _f = _f.copyWith(clearCity: true)
                        : _f = _f.copyWith(city: v))),
              if (fac.contracts.isNotEmpty)
                _facetRow('Contrat', fac.contracts, _f.contract, (v) => setState(
                    () => v == null
                        ? _f = _f.copyWith(clearContract: true)
                        : _f = _f.copyWith(contract: v))),
              _chipRow('Correspondance', [
                ('Tous', !_f.matchOnly,
                    () => setState(() => _f = _f.copyWith(matchOnly: false))),
                ('✔ Correspond', _f.matchOnly,
                    () => setState(() => _f = _f.copyWith(matchOnly: true))),
              ]),
              _chipRow('Détectées', [
                ('30 min', _f.dateFilter == '30m',
                    () => setState(() => _f = _f.copyWith(dateFilter: '30m'))),
                ('1 h', _f.dateFilter == '1h',
                    () => setState(() => _f = _f.copyWith(dateFilter: '1h'))),
                ('5 h', _f.dateFilter == '5h',
                    () => setState(() => _f = _f.copyWith(dateFilter: '5h'))),
                ('24 h', _f.dateFilter == '24h',
                    () => setState(() => _f = _f.copyWith(dateFilter: '24h'))),
                ('3 j', _f.dateFilter == '3d',
                    () => setState(() => _f = _f.copyWith(dateFilter: '3d'))),
                ('7 j', _f.dateFilter == '7d',
                    () => setState(() => _f = _f.copyWith(dateFilter: '7d'))),
                ('30 j', _f.dateFilter == '30d',
                    () => setState(() => _f = _f.copyWith(dateFilter: '30d'))),
                ('Toutes', _f.dateFilter == null,
                    () => setState(() => _f = _f.copyWith(clearDate: true))),
              ]),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 14)),
                      child: const Text('Annuler'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: FilledButton.icon(
                      onPressed: () => Navigator.of(context)
                          .pop(_f.copyWith(query: _q.text.trim())),
                      style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 14)),
                      icon: const Icon(Icons.check_rounded),
                      label: const Text('OK — appliquer'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _facetRow(String label, List<FacetValue> values, String? selected,
      ValueChanged<String?> onPick) {
    return _chipRow('$label (${values.length})', [
      ('Tous', selected == null, () => onPick(null)),
      for (final v in values.take(24))
        ('${v.value} · ${v.count}', selected == v.value, () => onPick(v.value)),
    ]);
  }

  Widget _chipRow(String label, List<(String, bool, VoidCallback)> items) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(label,
                style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.3,
                    color: scheme.onSurfaceVariant)),
          ),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              for (final (t, sel, onTap) in items)
                ChoiceChip(
                  label:
                      Text(t, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                  selected: sel,
                  onSelected: (_) => onTap(),
                  visualDensity: VisualDensity.compact,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  showCheckmark: false,
                ),
            ],
          ),
        ],
      ),
    );
  }
}
