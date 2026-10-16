import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:jobcenter/theme/app_theme.dart';
import 'package:jobcenter/utils/company.dart';
import 'package:jobcenter/utils/time.dart';
import 'package:jobcenter/widgets/avatars.dart';
import 'package:jobcenter/widgets/empty_state.dart';
import 'package:jobcenter/widgets/offer_card.dart'
    show offerCity, offerIsMatch, offerKeywords, offerStatusLabel, offerTime;
import 'package:jobcenter/widgets/section_header.dart';
import 'package:jobcenter/widgets/status_chip.dart';

void main() {
  group('time helpers', () {
    test('fmtTime zero-pads', () {
      expect(fmtTime(DateTime(2026, 1, 2, 9, 5)), '09:05');
    });

    test('fmtFull includes date + time', () {
      expect(fmtFull(DateTime(2026, 9, 19, 8, 30)), '19/09/2026 08:30');
    });

    test('timeAgo minutes / hours / days', () {
      expect(timeAgo(DateTime.now().subtract(const Duration(minutes: 5))),
          'il y a 5 minutes');
      expect(timeAgo(DateTime.now().subtract(const Duration(hours: 2))),
          'il y a 2 heures');
      expect(timeAgo(DateTime.now().subtract(const Duration(days: 1))), 'hier');
    });
  });

  group('company cleaning', () {
    test('strips html link wrappers', () {
      expect(cleanCompany('<a href="x">SEGULA Technologies </a>'),
          'SEGULA Technologies');
    });

    test('strips logo img alt', () {
      expect(cleanCompany('<img alt="Capgemini logo" src="x">'),
          'Capgemini');
    });

    test('collapses whitespace + handles entities', () {
      expect(cleanCompany('  Talan   &amp;  Co  '), 'Talan & Co');
    });

    test('null / empty -> empty string', () {
      expect(cleanCompany(null), '');
      expect(cleanCompany('null'), '');
    });
  });

  group('offer helpers', () {
    test('status labels', () {
      expect(offerStatusLabel('new'), 'Nouvelle');
      expect(offerStatusLabel('to_apply'), 'À postuler');
      expect(offerStatusLabel('applied'), 'Postulée ✓');
      expect(offerStatusLabel('rejected'), 'Refusée');
      expect(offerStatusLabel('x'), 'Nouvelle');
    });

    test('match detection', () {
      expect(offerIsMatch({'match': true}), isTrue);
      expect(offerIsMatch({'score': 3}), isTrue);
      expect(offerIsMatch({'score': 1}), isFalse);
      expect(offerIsMatch({}), isFalse);
    });

    test('city & remote detection', () {
      expect(offerCity({'location': 'Tunis'}), 'Tunis');
      expect(offerCity({'location': 'Télétravail possible à distance'}),
          'À distance');
      expect(offerCity({}), '');
    });

    test('offerTime prefers postedAt', () {
      final a = DateTime(2026, 9, 19, 10);
      final b = DateTime(2026, 9, 18, 10);
      expect(offerTime({'postedAt': a, 'updatedAt': b}), a);
      expect(offerTime({'updatedAt': b}), b);
      expect(offerTime({}), isNull);
    });

    test('keywords cleaned from html', () {
      expect(offerKeywords({'keywords': ['embarqué', '<b>C++</b>', '  Java  ']}),
          ['embarqué', 'C++', 'Java']);
    });
  });

  group('widget smoke tests', () {
    testWidgets('brand theme + tokens build', (tester) async {
      await tester.pumpWidget(MaterialApp(theme: AppTheme.light()));
      expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).theme,
          isNotNull);
      expect(Brand.navy, const Color(0xFF1E3A5F));
      expect(Brand.teal, const Color(0xFF0E7666));
    });

    testWidgets('brand avatar shows initials', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BrandAvatar(label: 'Capgemini Engineering', size: 40)),
      ));
      expect(find.text('CE'), findsOneWidget);
    });

    testWidgets('status chip + match chip render', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: Row(children: [
            StatusChip(label: 'Nouvelle', color: Colors.red),
            MatchChip(),
          ]),
        ),
      ));
      expect(find.text('Nouvelle'), findsOneWidget);
      expect(find.text('Correspond à ton profil'), findsOneWidget);
    });

    testWidgets('section header with subtitle', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: SectionHeader(title: 'Titre', subtitle: 'Sous-titre'),
        ),
      ));
      expect(find.text('Titre'), findsOneWidget);
      expect(find.text('Sous-titre'), findsOneWidget);
    });

    testWidgets('empty state shows content', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: EmptyState(
            icon: Icons.search_off,
            title: 'Rien ici',
            subtitle: 'Essaie autre chose',
          ),
        ),
      ));
      expect(find.text('Rien ici'), findsOneWidget);
      expect(find.text('Essaie autre chose'), findsOneWidget);
    });
  });
}