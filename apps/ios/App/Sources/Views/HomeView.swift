import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var settings: AppSettings
    @State private var confirmLogoutAll = false
    @State private var showNewMaterial = false

    var body: some View {
        NavigationStack {
            List {
                Section("home.uploads") {
                    UploadQueueView()
                }
                Section {
                    Toggle("settings.deleteLocalAfterReceipt", isOn: $settings.deleteLocalAfterReceipt)
                } header: { Text("settings.localCopies") } footer: { Text("settings.deleteLocalAfterReceipt.help") }
                Section("settings.session") {
                    Button("settings.logout") { Task { await app.logout(allSessions: false) } }
                    Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }
                }
            }
            .navigationTitle("home.title")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNewMaterial = true } label: { Label("material.new", systemImage: "plus") }
                }
            }
            .sheet(isPresented: $showNewMaterial) { NewMaterialView() }
            .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
                Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
            }
        }
    }
}
