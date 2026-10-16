import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/db_api.dart';
import '../theme/app_theme.dart';
import '../utils/time.dart';
import '../widgets/avatars.dart';
import '../widgets/empty_state.dart';
import '../widgets/skeleton.dart';

const _homeMap = <String, String>{
  'sagemcom': 'https://careers-tunisia.sagemcom.com/',
  'linkedin': 'https://www.linkedin.com/jobs/',
  'remotive': 'https://remotive.com',
  'remoteok': 'https://remoteok.com',
  'himalayas': 'https://himalayas.app/jobs',
  'remoteco': 'https://remote.co/remote-jobs/',
  'jobijoba': 'https://www.jobijoba.com/fr/',
  'capgemini-tn': 'https://www.capgemini.com/fr-fr/carrieres/tunisie/',
  'capgemini-fr': 'https://www.capgemini.com/fr-fr/carrieres/',
  'stmicro': 'https://stmicroelectronics.eightfold.ai/careers',
  'talan': 'https://jobs.smartrecruiters.com/Talan',
  'airbus': 'https://ag.wd3.myworkdayjobs.com/Airbus',
  'thales': 'https://thales.wd3.myworkdayjobs.com/Careers',
  'nxp': 'https://nxp.wd3.myworkdayjobs.com/Careers',
  'continental': 'https://jobs.smartrecruiters.com/continental',
  'wttj': 'https://www.welcometothejungle.com/fr/jobs',
  'jobteaser': 'https://www.jobteaser.com/fr/job-offers',
};

String _slug(String s) => s
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
    .replaceAll(RegExp(r'^-+|-+$'), '');

String _cap(String s) {
  if (s.isEmpty) return s;
  return s[0].toUpperCase() + s.substring(1);
}

String _typeLabel(Map<String, dynamic> o) {
  final t = (o['type'] ?? '').toString();
  final b = (o['board'] ?? '').toString();
  switch (t) {
    case 'rss':
      return 'RSS';
    case 'html':
      return b.isEmpty ? 'Board' : 'Board · ${_cap(b)}';
    case 'workday':
      return 'Workday';
    case 'smartrecruiters':
      return 'SmartRecruiters';
    case 'eightfold':
      return 'Eightfold';
    case 'capgemini':
      return 'Capgemini';
    case 'linkedin':
      return 'LinkedIn';
    case 'remotive':
      return 'Remotive';
    case 'remoteok':
      return 'RemoteOK';
    case 'experteer':
      return 'Experteer';
    case 'render':
      return 'SPA';
    default:
      return _cap(t);
  }
}

String _humanUrl(Map<String, dynamic> src, String id) {
  final url = (src['url'] ?? '').toString();
  final render = (src['renderUrl'] ?? '').toString();
  final feed =
      RegExp(r'(offerRss|\.rss|\.xml|\.atom)', caseSensitive: false);
  if (url.isNotEmpty && !feed.hasMatch(url)) return url;
  if (render.isNotEmpty && !feed.hasMatch(render)) return render;
  return _homeMap[id] ?? url;
}

class _NewSource {
  _NewSource({
    required this.name,
    required this.type,
    required this.board,
    required this.url,
    required this.country,
    required this.keywords,
  });
  final String name;
  final String type;
  final String board;
  final String url;
  final String country;
  final String keywords;
}

class SourcesScreen extends StatefulWidget {
  const SourcesScreen({super.key});

  @override
  State<SourcesScreen> createState() => _SourcesScreenState();
}

class _SourcesScreenState extends State<SourcesScreen> {
  String _query = '';
  List<Map<String, dynamic>> _sources = [];
  bool _loaded = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _reload();
    _poll = Timer.periodic(const Duration(seconds: 20), (_) => _reload(silent: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    try {
      final list = await DbApi.sources();
      if (!mounted) return;
      setState(() {
        _sources = list;
        _loaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      if (!silent) setState(() => _loaded = true);
    }
  }

  Future<void> _refresh() async {
    await _reload();
  }

  Future<void> _open(String url) async {
    final u = Uri.tryParse(url);
    if (u == null || u.host.isEmpty) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
  }

  Future<void> _toggleEnabled(String id, bool enabled) async {
    await DbApi.updateSource(id, {'enabled': enabled});
    await _reload(silent: true);
  }

  Future<void> _askAdd() async {
    final res = await showModalBottomSheet<_NewSource>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (_) => const _AddSourceSheet(),
    );
    if (res == null) return;
    await _addSource(res);
  }

  Future<void> _addSource(_NewSource s) async {
    var url = s.url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://$url';
    }
    final id = _slug(s.name).isEmpty
        ? 'source-${DateTime.now().millisecondsSinceEpoch}'
        : _slug(s.name);
    try {
      await DbApi.createSource({
        'id': id,
        'name': s.name.trim(),
        'type': s.type,
        if (s.type == 'html') 'board': s.board,
        'url': url,
        'country': s.country.trim(),
        if (s.keywords.trim().isNotEmpty)
          'queries': s.keywords
              .split(',')
              .map((e) => e.trim())
              .where((e) => e.isNotEmpty)
              .toList(),
        'enabled': true,
        'addedByApp': true,
        'intervalMs': 30 * 60 * 1000,
      });
      await _reload(silent: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
          s.type == 'rss'
              ? 'Source ajoutée · scan RSS automatique démarré.'
              : 'Raccourci ajouté · pas de scan auto pour ce type.',
        ),
        duration: const Duration(seconds: 3),
      ));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Impossible d\'ajouter la source : $e'),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Sources'),
        actions: [
          IconButton(
            tooltip: 'Ajouter une ressource',
            onPressed: _askAdd,
            icon: const Icon(Icons.add_link_rounded),
          ),
        ],
      ),
      body: !_loaded
          ? const SkeletonList(count: 6)
          : _sourcesBody(),
    );
  }

  Widget _sourcesBody() {
    final scheme = Theme.of(context).colorScheme;
    final all = _sources
        .map((m) => (
              id: (m['id'] ?? '').toString(),
              data: m,
            ))
        .toList()
      ..sort((a, b) {
        final na = (a.data['name'] ?? a.id).toString().toLowerCase();
        final nb = (b.data['name'] ?? b.id).toString().toLowerCase();
        return na.compareTo(nb);
      });
    final list = _query.isEmpty
        ? all
        : all
            .where((d) => (d.data['name'] ?? d.id)
                .toString()
                .toLowerCase()
                .contains(_query.toLowerCase()))
            .toList();
    if (all.isEmpty) {
      return const EmptyState(
        icon: Icons.link,
        title: 'Aucune source',
        subtitle: 'Ajoute une ressource (flux RSS, job board, …) pour élargir ta recherche.',
      );
    }
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
          child: TextField(
            onChanged: (v) => setState(() => _query = v.trim()),
            decoration: InputDecoration(
              hintText: 'Rechercher une source…',
              prefixIcon: const Icon(Icons.search, size: 20),
              isDense: true,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 9),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            child: list.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: const [
                      SizedBox(height: 30),
                      EmptyState(
                        icon: Icons.search_off,
                        title: 'Aucune source',
                        subtitle: 'Aucune source ne correspond à ta recherche.',
                      ),
                    ],
                  )
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 90),
                    itemCount: list.length,
                    itemBuilder: (context, i) =>
                        _sourceCard(list[i].id, list[i].data, scheme),
                  ),
          ),
        ),
      ],
    );
  }

  Widget _sourceCard(
    String id,
    Map<String, dynamic> o,
    ColorScheme scheme,
  ) {
    final name = (o['name'] ?? id).toString();
    final url = _humanUrl(o, id);
    final enabled = o['enabled'] != false;
    final typeLabel = _typeLabel(o);
    final country = (o['country'] ?? '').toString();
    final note = (o['note'] ?? '').toString();
    final last = o['lastCrawlAt'];

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: url.isEmpty ? null : () => _open(url),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          child: Row(
            children: [
              BrandAvatar(label: name, color: Brand.colorFor(name), size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 14.5,
                              color: enabled
                                  ? scheme.onSurface
                                  : scheme.onSurfaceVariant.withValues(alpha: 0.55),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Container(
                          constraints: const BoxConstraints(maxWidth: 140),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: enabled
                                ? scheme.secondaryContainer
                                : scheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            typeLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              color: enabled
                                  ? scheme.onSecondaryContainer
                                  : scheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Wrap(
                      spacing: 8,
                      runSpacing: 2,
                      children: [
                        if (country.isNotEmpty)
                          _mini(scheme, Icons.place_outlined, country),
                        if (note.isNotEmpty)
                          _mini(scheme, Icons.info_outline, note),
                        if (last != null)
                          _mini(
                            scheme,
                            Icons.history,
                            'scan ${_ago(timeToDate(last))}',
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              if (url.isNotEmpty)
                IconButton(
                  tooltip: 'Ouvrir',
                  onPressed: () => _open(url),
                  icon: const Icon(Icons.open_in_new, size: 19),
                  color: scheme.primary,
                ),
              Switch(
                value: enabled,
                onChanged: (v) => _toggleEnabled(id, v),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _mini(ColorScheme scheme, IconData icon, String text) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 190),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12.5, color: scheme.onSurfaceVariant),
          const SizedBox(width: 3),
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 11.5, color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }

  String _ago(DateTime t) {
    final diff = DateTime.now().difference(t);
    if (diff.inMinutes < 1) return 'à l\'instant';
    if (diff.inMinutes < 60) return 'il y a ${diff.inMinutes} min';
    if (diff.inHours < 24) return 'il y a ${diff.inHours} h';
    return 'il y a ${diff.inDays} j';
  }
}

class _AddSourceSheet extends StatefulWidget {
  const _AddSourceSheet();

  @override
  State<_AddSourceSheet> createState() => _AddSourceSheetState();
}

class _AddSourceSheetState extends State<_AddSourceSheet> {
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _country = TextEditingController();
  final _keywords = TextEditingController();
  String _type = 'rss';
  String _board = 'keejob';
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _country.dispose();
    _keywords.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _name.text.trim();
    var url = _url.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Donne un nom à la ressource.');
      return;
    }
    if (url.isEmpty) {
      setState(() => _error = 'Colle l\'adresse de la ressource.');
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://$url';
    }
    final u = Uri.tryParse(url);
    if (u == null || u.host.isEmpty) {
      setState(() => _error = 'Cette adresse n\'est pas valide.');
      return;
    }
    Navigator.of(context).pop(_NewSource(
      name: name,
      type: _type,
      board: _board,
      url: url,
      country: _country.text.trim(),
      keywords: _keywords.text.trim(),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
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
                  Text('Ajouter une ressource',
                      style: Theme.of(context)
                          .textTheme
                          .titleLarge
                          ?.copyWith(fontWeight: FontWeight.w800)),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _name,
                decoration: const InputDecoration(
                  labelText: 'Nom (ex. : MyNewBoard)',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Adresse (URL)',
                  hintText: 'https://…',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 12),
              Text('Type',
                  style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w800,
                      color: scheme.onSurfaceVariant)),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                initialValue: _type,
                isExpanded: true,
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  isDense: true,
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                ),
                items: const [
                  DropdownMenuItem(
                    value: 'rss',
                    child: Text('Flux RSS — scan automatique'),
                  ),
                  DropdownMenuItem(
                    value: 'html',
                    child: Text('Job board — raccourci (pas de scan auto)'),
                  ),
                ],
                onChanged: (v) => setState(() => _type = v ?? 'rss'),
              ),
              if (_type == 'html') ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _board,
                  decoration: const InputDecoration(
                    labelText: 'Plateforme',
                    border: OutlineInputBorder(),
                    isDense: true,
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'keejob', child: Text('Keejob')),
                    DropdownMenuItem(
                        value: 'tanitjobs', child: Text('TanitJobs')),
                    DropdownMenuItem(
                        value: 'tunisiejob', child: Text('TunisieJob')),
                    DropdownMenuItem(
                        value: 'jobijoba', child: Text('Jobijoba')),
                  ],
                  onChanged: (v) => setState(() => _board = v ?? 'keejob'),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                controller: _country,
                decoration: const InputDecoration(
                  labelText: 'Pays / région',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _keywords,
                decoration: const InputDecoration(
                  labelText: 'Mots-clés (optionnel, séparés par des virgules)',
                  hintText: 'automatisme, embarqué, iot',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(_error!,
                    style: TextStyle(
                        color: scheme.error, fontWeight: FontWeight.w700)),
              ],
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _submit,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                icon: const Icon(Icons.add_link_rounded),
                label: const Text('Ajouter'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}