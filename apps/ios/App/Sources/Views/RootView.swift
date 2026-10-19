import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        switch app.phase {
        case .loading:
            ProgressView()
        case .signedOut:
            LoginView()
        case .signedIn:
            HomeView()
        }
    }
}
