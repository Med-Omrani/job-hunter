import 'package:flutter/foundation.dart';

class AppState {
  static final ValueNotifier<int> tabIndex = ValueNotifier<int>(0);

  /// Offer id a notification tap asked to open, or null when there is nothing
  /// pending. Tapping a push used to switch to the offers tab and stop there,
  /// which made the user hunt for the right card in a long list.
  ///
  /// It is a one-shot mailbox rather than a direct navigation call on purpose:
  /// a tap can arrive BEFORE the widget tree exists (cold start via
  /// `getInitialMessage`, which main() awaits before `runApp`), so there is no
  /// navigator to push onto yet. OffersScreen consumes the value when it mounts,
  /// then clears it. Static state is what makes that ordering safe.
  ///
  /// A ValueListenable rather than a ValueNotifier: it exposes `addListener`, so
  /// callers do not need a StreamSubscription and cannot leak one.
  static final ValueNotifier<String?> openOfferId = ValueNotifier<String?>(null);

  static ValueListenable<String?> get openOfferRequests => openOfferId;

  /// CV skin used by every Adapter flow. `true` = the optional "pro" template
  /// (CV/cv_pro.tex); `false` = the default frozen CV/cv.tex.
  ///
  /// Sticky for the app session and shared by both adapter entry points (the
  /// offer-detail / apply-sheet button and the offers-list quick action), so
  /// toggling it once keeps the whole app in sync instead of silently
  /// re-rendering the default skin from the list. The `cv pro` token appended
  /// to the adapter message is what task-worker reads.
  static final ValueNotifier<bool> cvPro = ValueNotifier<bool>(false);
}