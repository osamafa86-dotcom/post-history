import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch app.phase {
            case .loading:
                ProgressView()
            case .signedOut:
                LoginView()
            case .signedIn:
                HomeView()
            case .revoked:
                SessionRevokedView()
            case .wiped(let report):
                WipedView(report: report)
            }
            // إخفاء المحتوى في مبدّل التطبيقات: غطاء حين لا يكون المشهد نشطًا.
            if scenePhase != .active {
                Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            }
        }
    }
}
