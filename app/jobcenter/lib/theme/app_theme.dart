import 'package:flutter/material.dart';

abstract final class Brand {
  static const navy = Color(0xFF1E3A5F);
  static const navyDark = Color(0xFF0F233E);
  static const teal = Color(0xFF0E7666);
  static const amber = Color(0xFFB26A00);

  static LinearGradient gradient({double begin = -0.3, double end = 1.1}) {
    return LinearGradient(
      begin: Alignment.centerLeft,
      end: Alignment.centerRight,
      colors: const [Color(0xFF1E3A5F), Color(0xFF2C539E)],
    );
  }

  static Color colorFor(String name) {
    switch (name.toLowerCase()) {
      case 'capgemini':
      case 'capgemini engineering':
      case 'sagemcom':
        return const Color(0xFF0E7666);
      case 'airbus':
        return const Color(0xFF1E3A5F);
      case 'stmicroelectronics':
        return const Color(0xFF03234B);
      case 'talan':
        return const Color(0xFF8C2E6C);
      case 'air liquide':
        return const Color(0xFF1B4D8F);
      case 'valeo':
        return const Color(0xFF6E1E3A);
      case 'scalian':
        return const Color(0xFF2E5D3A);
      case 'inetum':
        return const Color(0xFF27408B);
      case 'expleo':
        return const Color(0xFFE8552B);
      case 'leoni tunisia':
        return const Color(0xFFB26A00);
      case 'socomec':
        return const Color(0xFF00549F);
      case 'caveo automotive':
      case 'caveo':
        return const Color(0xFF123B5C);
      case 'visteon':
        return const Color(0xFF045093);
      case 'harmattan ai':
        return const Color(0xFF9C28B0);
      case 'bosch':
        return const Color(0xFFD2001C);
      case 'siemens':
        return const Color(0xFF009999);
      case 'schneider electric':
        return const Color(0xFF3DCD58);
      case 'thales':
        return const Color(0xFF1F3B8B);
      case 'safran':
        return const Color(0xFF002255);
      case 'alstom':
        return const Color(0xFF0059BC);
      case 'renault':
        return const Color(0xFFFFC300);
      case 'stellantis':
        return const Color(0xFF5A1E90);
      case 'segula technologies':
        return const Color(0xFFF04E23);
      case 'altran':
        return const Color(0xFF00A8E0);
      case 'alten':
        return const Color(0xFF8B2124);
      case 'assystem':
        return const Color(0xFF00A7A2);
      case 'sopra steria':
        return const Color(0xFFB5007C);
      case 'atos':
        return const Color(0xFF63666A);
      case 'worldline':
        return const Color(0xFF0B4F9E);
      case 'vermeg':
        return const Color(0xFF0090DA);
      case 'sofrecom tunisia':
        return const Color(0xFFF26522);
      case 'telnet':
        return const Color(0xFF0B5394);
      case 'dxc technology':
        return const Color(0xFF003366);
      default:
        return const Color(0xFF1E3A5F);
    }
  }
}

abstract final class AppTheme {
  static const double radius = 18;
  static const double radiusSm = 12;

  static ThemeData light() => _base(Brightness.light, _lightScheme());
  static ThemeData dark() => _base(Brightness.dark, _darkScheme());

  static ColorScheme _lightScheme() => const ColorScheme.light(
        primary: Color(0xFF1E3A5F),
        onPrimary: Colors.white,
        primaryContainer: Color(0xFFD9E6F5),
        onPrimaryContainer: Color(0xFF0B1E3A),
        secondary: Color(0xFF0E7666),
        onSecondary: Colors.white,
        secondaryContainer: Color(0xFFB8EAE0),
        onSecondaryContainer: Color(0xFF0A3E38),
        tertiary: Color(0xFF5B6472),
        onTertiary: Colors.white,
        error: Color(0xFFBA1A1A),
        onError: Colors.white,
        surface: Color(0xFFF7F9FC),
        onSurface: Color(0xFF16202C),
        surfaceContainerHighest: Color(0xFFDDE4EF),
        surfaceContainerHigh: Color(0xFFE6EBF4),
        surfaceContainer: Color(0xFFEEF2F8),
        surfaceContainerLow: Color(0xFFF2F5FA),
        surfaceContainerLowest: Colors.white,
        outline: Color(0xFF8994A6),
        outlineVariant: Color(0xFFCCD5E2),
        shadow: Color(0xFF0F233E),
        scrim: Color(0xFF1B2534),
        inverseSurface: Color(0xFF2C3747),
        onInverseSurface: Color(0xFFE9EFF7),
        inversePrimary: Color(0xFF9EC5F0),
      );

  static ColorScheme _darkScheme() => const ColorScheme.dark(
        primary: Color(0xFF9EC5F0),
        onPrimary: Color(0xFF0B2545),
        primaryContainer: Color(0xFF1C3D6B),
        onPrimaryContainer: Color(0xFFD6E6FB),
        secondary: Color(0xFF4EE0CE),
        onSecondary: Color(0xFF003630),
        secondaryContainer: Color(0xFF0B5A50),
        onSecondaryContainer: Color(0xFFC2F3EA),
        tertiary: Color(0xFFBCC6D6),
        onTertiary: Color(0xFF263140),
        error: Color(0xFFFFB4AB),
        onError: Color(0xFF690005),
        surface: Color(0xFF0E1520),
        onSurface: Color(0xFFE3E9F2),
        surfaceContainerHighest: Color(0xFF2A3647),
        surfaceContainerHigh: Color(0xFF242F3F),
        surfaceContainer: Color(0xFF1B2432),
        surfaceContainerLow: Color(0xFF161E2A),
        surfaceContainerLowest: Color(0xFF09101A),
        outline: Color(0xFF8E9BB0),
        outlineVariant: Color(0xFF39475C),
        shadow: Colors.black,
        scrim: Colors.black,
        inverseSurface: Color(0xFFE3E9F2),
        onInverseSurface: Color(0xFF2C3747),
        inversePrimary: Color(0xFF1E3A5F),
      );

  static ThemeData _base(Brightness brightness, ColorScheme scheme) {
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        titleTextStyle: TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.w700,
          color: scheme.onSurface,
          letterSpacing: -0.3,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: brightness == Brightness.dark
            ? scheme.surfaceContainer
            : Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radius),
          side: BorderSide(
            color: scheme.outlineVariant.withValues(alpha: 0.7),
            width: 0.6,
          ),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 68,
        backgroundColor: brightness == Brightness.dark
            ? scheme.surfaceContainerLow
            : Colors.white,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.primaryContainer,
        elevation: 0,
        labelTextStyle: WidgetStateProperty.resolveWith((states) {
          final sel = states.contains(WidgetState.selected);
          return TextStyle(
            fontSize: 11.5,
            fontWeight: sel ? FontWeight.w700 : FontWeight.w500,
            color: sel ? scheme.primary : scheme.onSurfaceVariant,
          );
        }),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          final sel = states.contains(WidgetState.selected);
          return IconThemeData(
            color: sel ? scheme.primary : scheme.onSurfaceVariant,
            size: 24,
          );
        }),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          textStyle: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusSm),
          ),
        ),
      ),
      chipTheme: ChipThemeData(
        shape: StadiumBorder(
          side: BorderSide(color: scheme.outlineVariant),
        ),
        side: BorderSide(color: scheme.outlineVariant),
        backgroundColor: scheme.surfaceContainerLow,
        selectedColor: scheme.primaryContainer,
        labelStyle: TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w600,
          color: scheme.onSurface,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: brightness == Brightness.dark
            ? scheme.surfaceContainerHigh
            : scheme.surfaceContainerLow,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: BorderSide(color: scheme.primary, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: BorderSide(color: scheme.error),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSm),
          borderSide: BorderSide(color: scheme.error, width: 1.6),
        ),
        prefixIconColor: scheme.onSurfaceVariant,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: brightness == Brightness.dark
            ? scheme.surfaceContainerHighest
            : scheme.onSurface,
        contentTextStyle: TextStyle(
          color: brightness == Brightness.dark
              ? scheme.onSurface
              : scheme.surface,
          fontWeight: FontWeight.w600,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusSm),
        ),
        elevation: 3,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor:
            brightness == Brightness.dark ? scheme.surfaceContainerLow : Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
        showDragHandle: true,
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant.withValues(alpha: 0.5),
        thickness: 1,
        space: 1,
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
        },
      ),
      textTheme: const TextTheme(
        headlineSmall: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -0.5),
        titleLarge: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -0.3),
        titleMedium: TextStyle(fontWeight: FontWeight.w700, letterSpacing: -0.2),
        titleSmall: TextStyle(fontWeight: FontWeight.w700),
        bodyMedium: TextStyle(height: 1.35),
        bodySmall: TextStyle(height: 1.3),
      ),
    );
  }
}