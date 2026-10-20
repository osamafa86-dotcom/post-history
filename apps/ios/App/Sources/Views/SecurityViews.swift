import DeviceSecurity
import SwiftUI

/// شاشة «أُبطلت الجلسة»: الرموز وحالة الرفع مُحيت؛ لا تفاصيل عن السبب (قد يكون المشرف بعد بلاغ فقد الهاتف).
struct SessionRevokedView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.slash").font(.system(size: 48)).foregroundStyle(.red)
            Text("revoked.title").font(.title2.weight(.semibold))
            Text("revoked.body").multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("revoked.signInAgain") { app.acknowledgeAndSignIn() }.buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

/// بعد المسح الطارئ: ما مُسح وما تعذّر (أسماء خطوات لا مسارات)، ثم شاشة البداية.
struct WipedView: View {
    @EnvironmentObject private var app: AppModel
    let report: WipeReport

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: report.allClean ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                .font(.system(size: 48)).foregroundStyle(report.allClean ? .green : .orange)
            Text(report.allClean ? "wipe.done" : "wipe.partial").font(.title2.weight(.semibold))
            List(report.outcomes, id: \.step) { outcome in
                HStack {
                    Text(LocalizedStringKey("wipe.step." + outcome.step))
                    Spacer()
                    switch outcome.status {
                    case .wiped: Image(systemName: "checkmark").foregroundStyle(.green)
                    case .absent: Image(systemName: "minus").foregroundStyle(.secondary)
                    case .failed: Image(systemName: "xmark").foregroundStyle(.red)
                    }
                }
            }
            Button("wipe.continue") { app.acknowledgeAndSignIn() }.buttonStyle(.borderedProminent)
        }
        .padding()
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
