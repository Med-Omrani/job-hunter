import 'package:flutter/material.dart';

import '../app_state.dart';
import 'chat_screen.dart';
import 'docs_screen.dart';
import 'offers_screen.dart';
import 'profile_screen.dart';
import 'sources_screen.dart';

// Docker build: FailoverBanner is no-op (single Postgres, no backup). Keep for Firebase fallback.
class FailoverBanner extends StatelessWidget {
  const FailoverBanner({super.key});

  @override
  Widget build(BuildContext context) {
    // In Docker mode, always hidden. Firebase mode could re-enable if needed.
    return const SizedBox.shrink();
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: AppState.tabIndex,
      builder: (context, index, _) {
        const screens = [
          ChatScreen(),
          OffersScreen(),
          SourcesScreen(),
          DocsScreen(),
          ProfileScreen(),
        ];
        return Scaffold(
          body: Column(
            children: [
              const FailoverBanner(),
              Expanded(
                child: IndexedStack(index: index, children: screens),
              ),
            ],
          ),
          bottomNavigationBar: NavigationBar(
            selectedIndex: index,
            onDestinationSelected: (i) => AppState.tabIndex.value = i,
            destinations: const [
              NavigationDestination(
                  icon: Icon(Icons.chat_bubble_outline),
                  selectedIcon: Icon(Icons.chat_bubble),
                  label: 'Chat'),
              NavigationDestination(
                  icon: Icon(Icons.work_outline),
                  selectedIcon: Icon(Icons.work),
                  label: 'Offres'),
              NavigationDestination(
                  icon: Icon(Icons.public_outlined),
                  selectedIcon: Icon(Icons.public),
                  label: 'Sources'),
              NavigationDestination(
                  icon: Icon(Icons.description_outlined),
                  selectedIcon: Icon(Icons.description),
                  label: 'CV / Lettres'),
              NavigationDestination(
                  icon: Icon(Icons.person_outline),
                  selectedIcon: Icon(Icons.person),
                  label: 'Profil'),
            ],
          ),
        );
      },
    );
  }
}
