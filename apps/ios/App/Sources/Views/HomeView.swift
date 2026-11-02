import MaterialsCore
import SwiftUI
import UploadCore

/// وجهات الرئيسية؛ تفاصيل المادة تُدفع من «موادي» أو من إشعار عنها.
enum HomeRoute: Hashable { case uploads, materials, material(UUID), notifications, settings }

/// 03 · الرئيسية (docs/design/specs/reporter-v2.md): التحية، وزرّ «إرسال من الميدان» كبيرًا، والمسودات، وآخر الإرسالات بحالة رفعها،
/// و«موادي». الإرسال (04) يغطي الشاشة، والرفع (05) و«موادي» والإشعارات والإعدادات تُدفع فوقها، والإيصال (06) ورقة.
/// مدخل «المشاركة من المعرض» يأتي مع امتداد المشاركة لاحقًا (ADR 0088)، فلا يُعرض سطره هنا قبل أن يعمل.
struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @EnvironmentObject private var notifications: NotificationsModel
    @State private var path: [HomeRoute] = []
    @State private var sending = false
    @State private var editingDraft: MaterialDraft?
    /// شاشة الإرسال ظاهرة حتى يكتمل إغلاقها. الإيصال ينتظرها: إرسالة وصلت ملفاتها أثناء الحلقة يُقرَّر إيصالها عند «أرسل» نفسها،
    /// وورقةٌ تُطلب فوق غطاء يُغلق لا تظهر، وقد عُلِّم الإيصال معروضًا فلا يعود.
    @State private var sendCoverShown = false
    @State private var draftToDelete: MaterialDraft?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: VL.Space.s6) {
                    header
                    Button { sending = true } label: { Label("home.send", systemImage: "bolt.fill") }
                        .buttonStyle(VLButtonStyle(kind: .primary, size: .hero))
                    draftsSection
                    recentSection
                    Button("materials.title") { path.append(.materials) }.buttonStyle(.vlOutline)
                }
                .padding(VL.Space.s5)
            }
            .vlScreen()
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HomeRoute.self) { route in
                switch route {
                case .uploads: UploadsScreen()
                case .materials: MyMaterialsView { sending = true }
                case .material(let id): MaterialDetailView(materialId: id)
                case .notifications: NotificationsView()
                case .settings: SettingsScreen()
                }
            }
        }
        .tint(Color.vl.actionPrimary)
        .fullScreenCover(isPresented: $sending, onDismiss: { sendCoverShown = false }) {
            SendScreen(onSent: showUploads).onAppear { sendCoverShown = true }
        }
        .fullScreenCover(item: $editingDraft, onDismiss: { sendCoverShown = false }) { draft in
            SendScreen(draft: draft, onSent: showUploads).onAppear { sendCoverShown = true }
        }
        .sheet(item: Binding<ReceiptTarget?>(get: { sending || editingDraft != nil || sendCoverShown ? nil : queue.presentedReceipt },
                                             set: { queue.presentedReceipt = $0 })) { target in
            ReceiptScreen(target: target, onSendAnother: sendAfterSheet, onMyMaterials: { path = [.materials] })
        }
        .confirmationDialog("draft.delete.confirm.title", isPresented: Binding(get: { draftToDelete != nil }, set: { if !$0 { draftToDelete = nil } }),
                            titleVisibility: .visible, presenting: draftToDelete) { draft in
            Button("draft.delete", role: .destructive) { queue.discardDraft(draft) }
            Button("material.cancel", role: .cancel) {}
        } message: { _ in
            Text("draft.delete.confirm.message")
        }
        .onChange(of: notifications.presented) { _, presented in
            guard presented else { return }
            notifications.presented = false
            path = [.notifications]
        }
        .onChange(of: notifications.openedMaterialId) { _, id in
            guard let id else { return }
            path = [.materials, .material(id)]
        }
        .task { await app.loadProfile() }
    }

    private func showUploads() { path = [.uploads] }

    /// «إرسال آخر» من الإيصال: تُفتح شاشة الإرسال بعد أن تُغلق ورقة الإيصال.
    private func sendAfterSheet() {
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            sending = true
        }
    }

    // MARK: الرأس

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: VL.Space.s3) {
                greeting
                Spacer(minLength: VL.Space.s3)
                headerButtons
            }
            VStack(alignment: .leading, spacing: VL.Space.s3) {
                greeting
                headerButtons
            }
        }
    }

    private var greeting: some View {
        let morning = Calendar.current.component(.hour, from: Date()) < 12
        let text: Text
        if let name = app.workName {
            text = morning ? Text("home.greeting.morning.named \(name)") : Text("home.greeting.evening.named \(name)")
        } else {
            text = morning ? Text("home.greeting.morning") : Text("home.greeting.evening")
        }
        return text.vlText(.title).foregroundStyle(Color.vl.textPrimary).accessibilityAddTraits(.isHeader)
    }

    private var headerButtons: some View {
        HStack(spacing: VL.Space.s3) {
            VLIconButton(systemImage: "bell", label: "notifications.title", badge: notifications.unreadCount) { path.append(.notifications) }
            Button("tab.settings") { path.append(.settings) }.buttonStyle(.vlOutlineSmall)
        }
    }

    // MARK: المسودات وآخر الإرسالات

    @ViewBuilder private var draftsSection: some View {
        if !queue.drafts.isEmpty {
            VStack(alignment: .leading, spacing: VL.Space.s3) {
                VLSectionHeader("drafts.title")
                ForEach(queue.drafts) { draft in
                    HStack(spacing: VL.Space.s2) {
                        Button { editingDraft = draft } label: {
                            HStack(spacing: VL.Space.s3) {
                                Image(systemName: "doc.text").foregroundStyle(Color.vl.textSecondary).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: VL.Space.s1) {
                                    Group { if draft.title.isEmpty { Text("draft.untitled") } else { Text(verbatim: draft.title) } }
                                        .vlText(.headline).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                                    Text("draft.files \(draft.files.count)").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(minHeight: VL.Size.touchMin)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Button(role: .destructive) { draftToDelete = draft } label: {
                            Image(systemName: "trash").frame(width: VL.Size.touchMin, height: VL.Size.touchMin)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.vl.stateDanger)
                        .accessibilityLabel(Text("draft.delete"))
                    }
                    .padding(.horizontal, VL.Space.s4)
                    .padding(.vertical, VL.Space.s2)
                    .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.borderLine, lineWidth: VL.Border.hairline))
                }
            }
        }
    }

    @ViewBuilder private var recentSection: some View {
        let recent = queue.recentOriginals
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: VL.Space.s3) {
                VLSectionHeader("home.recent")
                ForEach(recent, id: \.id) { rec in
                    let item = queue.item(rec)
                    Button { path.append(.uploads) } label: {
                        UploadRow(title: rec.materialTitle ?? rec.filename,
                                  thumbnailPath: queue.localCopies.contains(rec.id) ? rec.sourcePath : nil,
                                  isVideo: rec.mimeType?.hasPrefix("video") ?? false, item: item,
                                  status: UploadRowStatus.make(item, network: queue.networkState))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("home.recent.hint"))
                }
            }
        }
    }
}
