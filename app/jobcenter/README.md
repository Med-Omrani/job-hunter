# JobHunter — Flutter app

The mobile client of [JobHunter](../..). It talks to the self-hosted backend over the REST
API (and WebSocket) rather than any third-party service.

## Screens

| File | Purpose |
| --- | --- |
| `lib/screens/offers_screen.dart` | Offers board: search, facets, groups, status |
| `lib/screens/offer_detail.dart` | Offer detail + apply sheet |
| `lib/screens/docs_screen.dart` | Generated CV/letter PDFs (open/share) |
| `lib/screens/chat_screen.dart` | Chat with the system / AI assistant |
| `lib/screens/hotline_screen.dart` | AI assistant conversation |
| `lib/screens/profile_screen.dart` | Profile & settings |
| `lib/screens/sources_screen.dart` | Job sources |

## Networking

`lib/services/api_config.dart` discovers the backend host (explicit override → stored URL →
probe of known candidates), so a VPN/LAN/emulator topology is handled without a rebuild.
Pass an explicit base URL at build time:

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=http://<host>:8081
```

## Structure

```
lib/
├── main.dart
├── app_state.dart
├── screens/        # feature screens
├── services/       # API host discovery + typed API client
├── theme/
├── utils/
└── widgets/        # shared UI building blocks
```
