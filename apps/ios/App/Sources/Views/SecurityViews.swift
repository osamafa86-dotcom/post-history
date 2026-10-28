import DeviceSecurity
import SwiftUI

/// شاشة «أُبطلت الجلسة»: الرموز وحالة الرفع مُحيت؛ لا تفاصيل عن السبب (قد يكون المشرف بعد بلاغ فقد الهاتف).
struct SessionRevokedView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        VStack(spacing: VL.Space.s5) {
            VLHeroIcon(systemImage: "lock.slash", tone: .bad)
            Text("revoked.title").vlText(.headingH2).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.center)
            Text("revoked.body").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
            Button("revoked.signInAgain") { app.acknowledgeAndSignIn() }.buttonStyle(.vlPrimary)
        }
        .padding(VL.Space.s5)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.vl.bgCanvas.ignoresSafeArea())
    }
}

/// بعد المسح الطارئ: ما مُسح وما تعذّر (أسماء خطوات لا مسارات)، ثم شاشة البداية.
struct WipedView: View {
    @EnvironmentObject private var app: AppModel
    let report: WipeReport

    var body: some View {
        VStack(spacing: VL.Space.s5) {
            VLHeroIcon(systemImage: report.allClean ? "checkmark.shield.fill" : "exclamationmark.shield.fill",
                       tone: report.allClean ? .good : .attention)
            Text(report.allClean ? "wipe.done" : "wipe.partial").vlText(.headingH2).foregroundStyle(Color.vl.textPrimary)
            ScrollView {
                VLCard {
                    ForEach(report.outcomes, id: \.step) { outcome in
                        HStack {
                            Text(LocalizedStringKey("wipe.step." + outcome.step)).vlText(.bodyMd).foregroundStyle(Color.vl.textPrimary)
                            Spacer()
                            switch outcome.status {
                            case .wiped: Image(systemName: "checkmark").foregroundStyle(Color.vl.toneGoodFg)
                            case .absent: Image(systemName: "minus").foregroundStyle(Color.vl.iconMuted)
                            case .failed: Image(systemName: "xmark").foregroundStyle(Color.vl.toneBadFg)
                            }
                        }
                    }
                }
            }
            Button("wipe.continue") { app.acknowledgeAndSignIn() }.buttonStyle(.vlPrimary)
        }
        .padding(VL.Space.s5)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.vl.bgCanvas.ignoresSafeArea())
    }
}

/// زر المسح الطارئ بتأكيد صريح على خطوتين (مفتاح ثم زر مدمّر).
struct EmergencyWipeButton: View {
    @EnvironmentObject private var app: AppModel
    @State private var confirm = false
    @State private var armed = false

    var body: some View {
        Button(role: .destructive) { confirm = true } label: { Label("wipe.action", systemImage: "trash.slash.fill") }
            .confirmationDialog("wipe.confirm.title", isPresented: $confirm, titleVisibility: .visible) {
                Button("wipe.confirm.yes", role: .destructive) { Task { await app.emergencyWipe() } }
                Button("wipe.confirm.no", role: .cancel) {}
            } message: { Text("wipe.confirm.body") }
    }
}
