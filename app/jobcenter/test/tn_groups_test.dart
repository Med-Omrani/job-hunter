import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:jobcenter/screens/offres/widgets/groups_tab.dart';

/// Builds a minimal offer row for the group view.
Map<String, dynamic> _offer(
  String id, {
  String country = 'Tunisie',
  String location = '',
}) =>
    <String, dynamic>{
      'id': id,
      'company': 'TestCo $id',
      'title': 'Technicien',
      'country': country,
      'location': location,
      'status': 'new',
    };

Widget _app(Widget child) => MaterialApp(home: Scaffold(body: child));

/// Pumps the group tab and switches it to the 'Pays' segmentation.
Future<void> _showCountries(WidgetTester tester, List<Map<String, dynamic>> offers) async {
  await tester.pumpWidget(
      _app(GroupsTab(offers: offers, onOpenGroup: (_, _, _) {})));
  await tester.tap(find.text('Pays'));
  await tester.pumpAndSettle();
}

void main() {
  group('Tunisie is split by area', () {
    testWidgets('splits on-site postings from regions and unplaced ones',
        (tester) async {
      final offers = <Map<String, dynamic>>[
        _offer('a', location: 'Tunis, Tunisie'),
        _offer('b', location: 'Tunis'),
        _offer('c', location: 'Ariana'),
        _offer('d', location: 'Sfax, Sfax, Tunisie'),
        _offer('e', location: ''),
        _offer('f', location: 'freelance'),
      ];

      await _showCountries(tester, offers);

      expect(find.text('Tunisie · Grand Tunis'), findsOneWidget);
      expect(find.textContaining('3 offres'), findsOneWidget);

      expect(find.text('Tunisie · Régions'), findsOneWidget);
      expect(find.textContaining('1 offres'), findsOneWidget);

      expect(find.text('Tunisie · Localisation non précisée'), findsOneWidget);
      expect(find.textContaining('2 offres'), findsOneWidget);
    });

    testWidgets('a blank location does not swallow every offer', (tester) async {
      // 'Location non précisée' used to win every comparison because the
      // needle list held an empty string, which contains() always matches.
      final offers = <Map<String, dynamic>>[
        _offer('a', location: 'Tunis'),
        _offer('b', location: ''),
      ];

      await _showCountries(tester, offers);

      expect(find.textContaining('1 offres'), findsNWidgets(2));
    });

    testWidgets('accented place names match their ascii needles', (tester) async {
      // 'télétravail' is a remote posting, not a region, and 'Mégrine' sits in
      // the capital belt. Both arrive accented from the scraped boards.
      final offers = <Map<String, dynamic>>[
        _offer('a', location: 'Mégrine'),
        _offer('b', location: 'télétravail'),
      ];

      await _showCountries(tester, offers);

      expect(find.text('Tunisie · Grand Tunis'), findsOneWidget);
      expect(find.text('Tunisie · Régions'), findsNothing);
      expect(find.text('Tunisie · Localisation non précisée'), findsOneWidget);
    });

    testWidgets('no single country can appear twice', (tester) async {
      final offers = <Map<String, dynamic>>[
        _offer('a', location: 'Tunis'),
        _offer('b', location: 'Sousse'),
        _offer('c', country: 'France', location: 'Paris'),
      ];

      await _showCountries(tester, offers);

      // Tunisie is split three ways, then France is listed on its own.
      expect(find.text('Tunisie · Grand Tunis'), findsOneWidget);
      expect(find.text('Tunisie · Régions'), findsOneWidget);
      expect(find.text('France'), findsOneWidget);
      expect(find.text('Tunisie'), findsNothing);
    });
  });
}
