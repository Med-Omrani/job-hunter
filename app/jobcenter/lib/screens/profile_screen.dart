import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/api_config.dart';
import '../services/api_host.dart';
import '../services/db_api.dart';
import '../theme/app_theme.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _phone = TextEditingController();
  final _apiUrl = TextEditingController();
  bool _saving = false;
  bool _loaded = false;
  bool _apiTesting = false;
  String? _apiTestResult;

  Future<void> _load() async {
    try {
      final p = await DbApi.profile();
      if ((p['name'] ?? '').toString().isNotEmpty || (p['email'] ?? '').toString().isNotEmpty) {
        _name.text = (p['name'] ?? '').toString();
        _email.text = (p['email'] ?? '').toString();
        _phone.text = (p['phone'] ?? '').toString();
      }
    } catch (_) {}
    _apiUrl.text = await ApiConfig.get();
    if (!mounted) return;
    setState(() => _loaded = true);
  }

  Future<void> _testApi() async {
    final url = _apiUrl.text.trim();
    if (url.isEmpty) return;
    setState(() { _apiTesting = true; _apiTestResult = null; });
    final ok = await ApiHost.test(url);
    if (!mounted) return;
    setState(() { _apiTesting = false; _apiTestResult = ok ? 'OK ✓' : 'Échec — vérifie l\'URL / PC allumé'; });
  }

  Future<void> _saveApi() async {
    final url = _apiUrl.text.trim();
    if (url.isEmpty) return;
    await ApiHost.setBaseUrl(url);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Serveur: $url ✓')));
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _saving = true);
    await DbApi.updateProfile({
      'name': _name.text.trim(),
      'email': _email.text.trim(),
      'phone': _phone.text.trim(),
    });
    if (!mounted) return;
    setState(() {
      _saving = false;
      _loaded = _name.text.trim().isNotEmpty;
    });
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Profil enregistré ✓')));
  }

  String get _initials {
    final n = _name.text.trim();
    if (n.isEmpty) return 'MO';
    final words = n.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.length == 1) return words.first.substring(0, 1).toUpperCase();
    return '${words[0][0]}${words[1][0]}'.toUpperCase();
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _phone.dispose();
    _apiUrl.dispose();
    super.dispose();
  }

  InputDecoration _dec(String label, IconData icon) {
    return InputDecoration(
      labelText: label,
      prefixIcon: Icon(icon),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppTheme.radius)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppTheme.radius),
      ),
      filled: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Profil')),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 100),
          children: [
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: Brand.gradient(),
                borderRadius: BorderRadius.circular(AppTheme.radius),
              ),
              child: Row(
                children: [
                  Container(
                    width: 58,
                    height: 58,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      _initials,
                      style: const TextStyle(
                        color: Brand.navy,
                        fontWeight: FontWeight.w800,
                        fontSize: 19,
                      ),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _name.text.trim().isEmpty
                              ? 'JobHunter tunisien'
                              : _name.text.trim(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                            fontSize: 17,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          _loaded
                              ? 'Profil à jour'
                              : 'Complète ton profil — l\'agent s\'en sert pour tes candidatures.',
                          style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.85),
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            _sectionLabel(scheme, 'Informations personnelles'),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  children: [
                    TextFormField(
                      controller: _name,
                      decoration: _dec('Nom complet', Icons.person_outline),
                      textCapitalization: TextCapitalization.words,
                      validator: (v) =>
                          (v == null || v.trim().isEmpty) ? 'Requis' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      decoration: _dec('Email de candidature', Icons.mail_outline),
                      validator: (v) =>
                          (v == null || !v.contains('@')) ? 'Email invalide' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _phone,
                      keyboardType: TextInputType.phone,
                      decoration: _dec('Téléphone', Icons.phone_outlined),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: scheme.secondaryContainer.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                children: [
                  Icon(Icons.info_outline,
                      size: 19, color: scheme.onSecondaryContainer),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Ces informations sont reprises sur ton CV et tes lettres générés par l\'agent.',
                      style: TextStyle(
                          fontSize: 12, color: scheme.onSecondaryContainer, height: 1.35),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _saving ? null : _save,
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 15),
              ),
              icon: _saving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white),
                    )
                  : const Icon(Icons.save_outlined),
              label: Text(_saving ? 'Sauvegarde…' : 'Enregistrer mon profil'),
            ),
            const SizedBox(height: 24),
            _sectionLabel(scheme, 'Serveur Docker (PC) — pour le mode hors même réseau'),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextFormField(
                      controller: _apiUrl,
                      decoration: _dec('URL du PC (https://xxx.trycloudflare.com ou http://<ip>:8081)', Icons.dns_outlined).copyWith(
                        helperText: 'Colle ici l\'URL du tunnel Cloudflare (change à chaque restart) ou l\'IP Wi-Fi du PC',
                        helperMaxLines: 2,
                      ),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _apiTesting ? null : _testApi,
                            icon: _apiTesting ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.wifi_tethering, size: 18),
                            label: Text(_apiTesting ? 'Test…' : 'Tester'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: _saveApi,
                            icon: const Icon(Icons.save_alt, size: 18),
                            label: const Text('Enregistrer'),
                          ),
                        ),
                      ],
                    ),
                    if (_apiTestResult != null) ...[
                      const SizedBox(height: 8),
                      Text(_apiTestResult!, style: TextStyle(fontSize: 12, color: _apiTestResult == 'OK ✓' ? Colors.green.shade700 : scheme.error, fontWeight: FontWeight.w600)),
                    ],
                    const SizedBox(height: 8),
                    Text('Sans PC allumé, l\'app affiche « Aucune offre » — normal. Ce champ évite de recompiler à chaque tunnel.', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionLabel(ColorScheme scheme, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.4,
          color: scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}