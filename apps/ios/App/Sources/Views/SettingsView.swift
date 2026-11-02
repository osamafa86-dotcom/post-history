import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UIKit

/// 12 · الإعدادات (docs/design/specs/reporter-v2.md): الحساب (اسم الظهور الافتراضي والمكان المتذكَّر)، والرفع (Wi‑Fi فقط،
/// وحذف النسخة المحلية بعد الإيصال)، والعرض (اللغة من إعدادات الهاتف، والمظهر وحجم الخط يتبعان الهاتف)، والأمان، والجلسة،
/// والمسح الطارئ. ما كان يعمل في الإعدادات باقٍ كما هو.
struct SettingsScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLockModel
    @EnvironmentObject private var queue: UploadQueueModel
    @State private var confirmLogoutAll = false
    @State private var memory = ReporterMemory()
    @State private var editingPlace = false
    @State private var placeGovernorate = ""
    @State private var placeCity = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s6) {
                section("settings.account") {
                    VStack(alignment: .leading, spacing: VL.Space.s3) {
                        row("material.displayName") {
                            Picker(selection: displayMode) {
                                ForEach(DisplayName.Mode.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) {
                                    Text(LocalizedStringKey("material.displayName." + $0.rawValue)).tag($0)
                                }
                            } label: { Text("material.displayName") }
                            .pickerStyle(.menu)
                            .tint(Color.vl.textBrand)
                        }
                        if memory.effectiveDisplayMode == .pseudonym {
                            VLField(label: Text("material.pseudonym")) {
                                TextField(text: pseudonym, prompt: Text(verbatim: "")) { Text("material.pseudonym") }
                            }
                        }
                        Text("settings.displayName.help").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                    }
                    divider
                    Button { editingPlace = true } label: {
                        row("settings.place") {
                            if memory.hasPlace {
                                Text(verbatim: "\(memory.governorate) · \(memory.city)").vlText(.body).foregroundStyle(Color.vl.textSecondary)
                            } else {
                                Text("settings.place.none").vlText(.body).foregroundStyle(Color.vl.textSecondary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("send.place.hint"))
                }
                section("settings.uploads") {
                    toggle("settings.uploadOverWifiOnly", help: "settings.uploadOverWifiOnly.help", isOn: $settings.uploadOverWifiOnly)
                        .onChange(of: settings.uploadOverWifiOnly) { _, _ in queue.updateNetworkState() }
                    divider
                    toggle("settings.deleteLocalAfterReceipt", help: "settings.deleteLocalAfterReceipt.help", isOn: $settings.deleteLocalAfterReceipt)
                }
                section("settings.display") {
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    } label: {
                        row("settings.language") {
                            HStack(spacing: VL.Space.s2) {
                                Text(verbatim: languageName).vlText(.body).foregroundStyle(Color.vl.textSecondary)
                                Image(systemName: "arrow.up.forward.app").foregroundStyle(Color.vl.textSecondary).accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("settings.language.hint"))
                    divider
                    row("settings.appearance") { Text("settings.followsPhone").vlText(.body).foregroundStyle(Color.vl.textSecondary) }
                    divider
                    row("settings.textSize") { Text("settings.followsPhone").vlText(.body).foregroundStyle(Color.vl.textSecondary) }
                }
                section("settings.security") {
                    toggle("settings.appLock",
                           help: lock.unavailable ? "settings.appLock.unavailable" : "settings.appLock.help",
                           isOn: Binding(get: { lock.state.isEnabled }, set: { on in Task { await lock.setEnabled(on) } }))
                }
                VStack(spacing: VL.Space.s3) {
                    Button("settings.logout") { Task { await app.logout(allSessions: false) } }.buttonStyle(.vlOutline)
                    Button("settings.logoutAll", role: .destructive) { confirmLogoutAll = true }.buttonStyle(.vlOutline)
                }
                VStack(alignment: .leading, spacing: VL.Space.s3) {
                    VLSectionHeader("wipe.section")
                    EmergencyWipeButton().buttonStyle(.vlOutline)
                    Text("wipe.help").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .navigationTitle("tab.settings")
        .navigationBarTitleDisplayMode(.large)
        .confirmationDialog("settings.logoutAll.confirm", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
            Button("settings.logoutAll", role: .destructive) { Task { await app.logout(allSessions: true) } }
        }
        .sheet(isPresented: $editingPlace, onDismiss: savePlace) {
            PlaceEditor(governorate: $placeGovernorate, city: $placeCity)
        }
        .onAppear {
            memory = app.memory.load()
            placeGovernorate = memory.governorate
            placeCity = memory.city
        }
    }

    private var languageName: String {
        let code = Locale.current.language.languageCode?.identifier ?? "ar"
        return Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    private var displayMode: Binding<DisplayName.Mode> {
        Binding(get: { memory.effectiveDisplayMode }, set: { mode in
            memory = app.memory.update { $0.displayMode = mode }
        })
    }

    private var pseudonym: Binding<String> {
        Binding(get: { memory.pseudonym }, set: { name in
            memory = app.memory.update { $0.pseudonym = name }
        })
    }

    private func savePlace() {
        let g = placeGovernorate, c = placeCity
        guard !g.isEmpty, !c.isEmpty, g != memory.governorate || c != memory.city else { return }
        memory = app.memory.update { $0.governorate = g; $0.city = c }
    }

    private var divider: some View { Divider().overlay(Color.vl.borderLine) }

    /// مجموعة إعدادات بعنوان قسم يعلنه قارئ الشاشة عنوانًا، في بطاقة.
    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            VLSectionHeader(title)
            VLCard(padding: VL.Space.s4) { content() }
        }
    }

    /// صف: التسمية ثم القيمة، ويُكدَّسان حين لا يتسعان (الخط الكبير).
    private func row<Value: View>(_ label: LocalizedStringKey, @ViewBuilder value: () -> Value) -> some View {
        let v = value()
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: VL.Space.s3) {
                Text(label).vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                Spacer(minLength: VL.Space.s3)
                v
            }
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Text(label).vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                v
            }
        }
        .frame(maxWidth: .infinity, minHeight: VL.Size.touchMin, alignment: .leading)
    }

    private func toggle(_ label: LocalizedStringKey, help: LocalizedStringKey, isOn: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s1) {
            Toggle(isOn: isOn) { Text(label).vlText(.headline).foregroundStyle(Color.vl.textPrimary) }
                .tint(Color.vl.actionPrimary)
                .frame(minHeight: VL.Size.touchMin)
            Text(help).vlText(.caption).foregroundStyle(Color.vl.textSecondary)
        }
    }
}
