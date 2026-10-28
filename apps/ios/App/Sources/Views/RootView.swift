import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var lock: AppLockModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch app.phase {
            case .loading:
                ProgressView().tint(Color.vl.bgBrand)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.vl.bgCanvas.ignoresSafeArea())
            case .signedOut:
                LoginView()
            case .signedIn:
                HomeView()
            case .revoked:
                SessionRevokedView()
            case .wiped(let report):
                WipedView(report: report)
            }
            if case .signedIn = app.phase, lock.state.isLocked {
                AppLockView()
            }
            // إخفاء المحتوى في مبدّل التطبيقات: غطاء حين لا يكون المشهد نشطًا.
            if scenePhase != .active {
                Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if case .signedIn = app.phase { lock.sceneChanged(to: phase, signedIn: true) } else { lock.sceneChanged(to: phase, signedIn: false) }
        }
    }
}
