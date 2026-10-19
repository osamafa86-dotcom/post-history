import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @State private var confirmLogoutAll = false

    var body: some View {
        NavigationStack {
            List {
                Section("home.uploads") {
                    Text("home.uploads.empty").foregroundStyle(.secondary)
                }
                Section("settings.session") {
                    Button("settings.logout") { Task { await app.logout(allSessions: false) } }
                    Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }
                }
            }
            .navigationTitle("home.title")
            .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
                Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
            }
        }
    }
}
