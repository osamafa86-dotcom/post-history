import AVFoundation
import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UIKit

// المشغّل (design-brief.md §5.3، الإطاران 08 و09؛ ADR 0089): أدوات خاصة فوق AVPlayer — تشغيل وإيقاف، وشريط وقت بمعاينة عند
// السحب، والسرعة، وإطار بإطار، وملء الشاشة والتدوير، والجودة، وكتم الصوت. لا مشاركة ولا تصدير ولا AirPlay ولا صورة داخل صورة،
// ولا تنزيل دون اتصال. لا يُسجَّل رابط ولا اسم ملف ولا عنوان. الرابط الموقّع في الذاكرة وحدها، ويُجدَّد عند انتهائه.

// MARK: - النموذج

@MainActor
final class PlayerModel: ObservableObject {
    enum Phase: Equatable { case idle, loading, ready, failed }

    /// السرعات المعروضة؛ 1× الافتراضية.
    static let speeds: [Float] = [0.5, 1, 1.5, 2]

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var isPlaying = false
    @Published private(set) var currentSeconds: Double = 0
    @Published private(set) var durationSeconds: Double = 0
    @Published private(set) var rate: Float = 1
    @Published private(set) var isMuted = false
    @Published private(set) var quality: PlaybackQuality?
    @Published private(set) var isScrubbing = false
    @Published private(set) var scrubSeconds: Double = 0
    /// إطار الموضع أثناء السحب، من نسخة الهاتف وحدها (لا طلبات شبكة إضافية للنسخة البعيدة؛ إطار المشغّل نفسه يتبع السحب).
    @Published private(set) var scrubPreview: Image?
    /// العرض ÷ الارتفاع بعد التحميل.
    @Published private(set) var videoAspect: CGFloat?

    let player: AVPlayer
    /// المصدر المطبَّق على العنصر الحالي.
    private(set) var source: PlaybackSource = .unavailable
    /// آخر مصدر طلبته الشاشة وبديله (`hls` ← `proxy`)؛ يُطبَّق عند التشغيل وإعادة المحاولة ولو جاء والمشغّل يعمل.
    private var requestedSource: PlaybackSource = .unavailable
    private var requestedFallback: PlaybackSource?
    private var fallbackSource: PlaybackSource?
    private var usedFallback = false
    /// موضع الاستئناف بعد تحميل عنصر جديد (تجديد الرابط، أو البديل): يُبحث عنه عند `readyToPlay` لا قبله.
    private var pendingResume: Double?
    private var link: (@Sendable (UUID) async throws -> FileDownloadUrl)?
    private var lease: SignedURLLease?
    private var refreshesWithoutProgress = 0
    private var progressMark: Double = 0
    private var loadToken = UUID()
    private var failureHandled = false
    private var reachedEnd = false
    private var wasPlayingBeforeScrub = false
    private var timeObserver: Any?
    private var observations: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []
    /// ملف نسخة الهاتف لمعاينة السحب؛ `nil` للنسخة البعيدة (الوقت وحده في الفقاعة).
    private var previewFile: URL?
    private var pendingPreview: Double?
    private var previewTask: Task<Void, Never>?
    private var seekInProgress = false
    private var chaseTarget: CMTime = .zero
    private var chaseExact = false
    /// يرتفع مع كل عنصر جديد، فاكتمال بحث في عنصر سابق لا يحرّك العنصر الجديد.
    private var seekEpoch = 0
    /// ما أراده المراسل (تشغيل أو إيقاف)، لا ما يقوله المشغّل لحظة الفشل أو التخزين المؤقت.
    private var wantsPlay = false

    init() {
        player = AVPlayer()
        // لا عرض على شاشة أخرى عبر AirPlay: لا شيء يخرج من المشغّل في هذا الإصدار.
        player.allowsExternalPlayback = false
        player.preventsDisplaySleepDuringVideoPlayback = true
    }

    /// آخر مصدر تطلبه الشاشة، يُحفظ دائمًا. متوقفًا يُطبَّق فورًا. وأثناء العرض: إن تبدّلت نسخة الهاتف (حذفها المراسل من الإيصال أو
    /// حُذفت بعده) يُترك العنصر فورًا فيُحرَّر مقبض الملف المحذوف، ويعود المشغّل إلى الملصق بالمصدر الجديد من الموضع نفسه؛ وتبدّل
    /// مصدر بعيد بآخر (صار `hls` جاهزًا) لا يقطع العرض ويُطبَّق في التشغيل التالي.
    func configure(source: PlaybackSource, fallback: PlaybackSource?, knownDurationSeconds: Double?,
                   link: @escaping @Sendable (UUID) async throws -> FileDownloadUrl) {
        self.link = link
        requestedSource = source
        requestedFallback = fallback
        if phase == .idle || phase == .failed, let knownDurationSeconds, knownDurationSeconds > 0 { durationSeconds = knownDurationSeconds }
        guard source != self.source else {
            // المصدر نفسه وصار له بديل (نسخة خفيفة تحقّقت بعد بدء `hls`).
            if !usedFallback { fallbackSource = fallback }
            return
        }
        switch phase {
        case .idle, .failed:
            apply(source, fallback: fallback)
        case .loading, .ready:
            guard case .local = self.source else { return }
            let position = isScrubbing ? scrubSeconds : currentSeconds
            stop()
            currentSeconds = position
            apply(source, fallback: fallback)
        }
    }

    private func apply(_ newSource: PlaybackSource, fallback: PlaybackSource?) {
        if newSource != source {
            lease = nil
            refreshesWithoutProgress = 0
        }
        source = newSource
        fallbackSource = fallback
        usedFallback = false
        quality = newSource.quality
        if phase == .failed { phase = .idle }
    }

    var canPlay: Bool { requestedSource != .unavailable }

    // MARK: التشغيل

    func togglePlay() { isPlaying ? pause() : play() }

    func play() {
        guard canPlay else { return }
        switch phase {
        case .idle, .failed:
            // آخر مصدر مطلوب لا ما بقي من قبل: إعادة المحاولة بعد حذف نسخة الهاتف لا تعود إلى ملف محذوف.
            apply(requestedSource, fallback: requestedFallback)
            guard source != .unavailable else { return }
            refreshesWithoutProgress = 0
            phase = .loading
            Task { await load(resumeAt: currentSeconds, autoplay: true) }
        case .loading:
            // ما زال يُحمَّل (تجديد رابط مثلًا): يبدأ التشغيل حين يجهز.
            wantsPlay = true
        case .ready:
            // رابط بعيد قارب الانتهاء والمشغّل متوقف: رابط جديد من الموضع نفسه قبل الاستئناف.
            if case .remote = source, SignedURLRefresh.beforePlayback(lease, now: Date()) == .fetchNew {
                phase = .loading
                Task { await load(resumeAt: currentSeconds, autoplay: true) }
                return
            }
            if reachedEnd {
                reachedEnd = false
                player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
            }
            wantsPlay = true
            PlaybackCenter.shared.activate(self)
            player.play()
        }
    }

    func pause() {
        wantsPlay = false
        player.pause()
    }

    func setRate(_ value: Float) {
        rate = value
        player.defaultRate = value
        if isPlaying { player.rate = value }
    }

    func toggleMute() {
        player.isMuted.toggle()
        isMuted = player.isMuted
    }

    /// إطار واحد للأمام أو للخلف (`AVPlayerItem.step(byCount:)`)؛ يوقف التشغيل أولًا.
    func step(_ count: Int) {
        guard phase == .ready, let item = player.currentItem else { return }
        guard count > 0 ? item.canStepForward : item.canStepBackward else { return }
        pause()
        item.step(byCount: count)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self, !self.isScrubbing else { return }
            self.currentSeconds = max(0, self.player.currentTime().seconds)
        }
    }

    /// تقديم أو تأخير بثوانٍ (إيماءة التعديل لقارئ الشاشة على شريط الوقت).
    func seek(by delta: Double) {
        guard phase == .ready else { return }
        let target = min(max(currentSeconds + delta, 0), max(durationSeconds, 0))
        currentSeconds = target
        chase(to: target, exact: true)
    }

    // MARK: السحب على شريط الوقت

    func beginScrub() {
        guard phase == .ready, !isScrubbing else { return }
        wasPlayingBeforeScrub = wantsPlay
        pause()
        isScrubbing = true
        scrubSeconds = currentSeconds
    }

    func scrub(to seconds: Double) {
        guard isScrubbing else { return }
        scrubSeconds = min(max(seconds, 0), max(durationSeconds, 0))
        // يتبع إطار المشغّل السحبَ بتسامح يُسرّع البحث (إطارات المفاتيح، وإطارات I في HLS)، والإفلات دقيق.
        chase(to: scrubSeconds, exact: false)
        requestPreview(at: scrubSeconds)
    }

    func endScrub() {
        guard isScrubbing else { return }
        isScrubbing = false
        currentSeconds = scrubSeconds
        reachedEnd = false
        chase(to: scrubSeconds, exact: true)
        // العنصر يُعاد تحميله (تجديد الرابط) والمراسل يسحب: يُستأنف من حيث أفلت حين يجهز.
        if player.currentItem?.status != .readyToPlay { pendingResume = scrubSeconds }
        pendingPreview = nil
        scrubPreview = nil
        if wasPlayingBeforeScrub { play() }
    }

    /// بحث «مطاردة» (Apple QA1820): بحث واحد في الطريق، وآخر موضع مطلوب يُبحث عنه بعده، فلا تتراكم طلبات البحث أثناء السحب.
    private func chase(to seconds: Double, exact: Bool) {
        let target = CMTime(seconds: seconds, preferredTimescale: 600)
        chaseTarget = target
        chaseExact = exact
        if !seekInProgress { seekToChaseTarget() }
    }

    private func seekToChaseTarget() {
        guard player.currentItem?.status == .readyToPlay else { return }
        seekInProgress = true
        let target = chaseTarget
        let epoch = seekEpoch
        let tolerance = chaseExact ? CMTime.zero : CMTime(seconds: 0.5, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, epoch == self.seekEpoch else { return }
                if CMTimeCompare(target, self.chaseTarget) == 0 { self.seekInProgress = false } else { self.seekToChaseTarget() }
            }
        }
    }

    /// المعاينة من نسخة الهاتف: آخر موضع مطلوب يفوز، وطلب واحد في كل لحظة.
    private func requestPreview(at seconds: Double) {
        guard previewFile != nil else { return }
        pendingPreview = seconds
        guard previewTask == nil else { return }
        previewTask = Task { [weak self] in
            while let self, let file = self.previewFile, let next = self.pendingPreview {
                self.pendingPreview = nil
                let image = await Self.previewFrame(file: file, seconds: next)
                if self.isScrubbing, let image { self.scrubPreview = Image(decorative: image, scale: 1) }
            }
            self?.previewTask = nil
        }
    }

    /// إطار مصغّر من ملف الهاتف خارج الخيط الرئيسي؛ المولّد محلي هنا فلا يعبر بين سياقات العزل.
    nonisolated private static func previewFrame(file: URL, seconds: Double) async -> CGImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320)
        let tolerance = CMTime(seconds: 0.25, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance
        return try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image
    }

    // MARK: التحميل والرابط

    private func load(resumeAt: Double, autoplay: Bool) async {
        let token = UUID()
        loadToken = token
        phase = .loading
        PlaybackCenter.shared.activate(self)
        let asset: AVURLAsset
        switch source {
        case .local(let local):
            lease = nil
            let file = UploadServices.shared.documentsDirectory.appendingPathComponent(local.relativePath)
            // النسخة حُذفت قبل أن تعلم الشاشة: لا يُفتح ملف غير موجود، ومحاولة واحدة لكل لمسة.
            guard FileManager.default.fileExists(atPath: file.path) else {
                phase = .failed
                return
            }
            previewFile = file
            asset = AVURLAsset(url: file)
        case .remote(let fileId, _, _):
            // يُطلب قبيل التشغيل، ولا يُكتب في أي مكان غير هذا النموذج.
            guard let link, let fresh = (try? await link(fileId)).flatMap({ SignedURLLease($0) }) else {
                if loadToken == token { phase = .failed }
                return
            }
            guard loadToken == token else { return }
            lease = fresh
            previewFile = nil
            asset = AVURLAsset(url: fresh.url)
        case .unavailable:
            phase = .idle
            return
        }
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .spectral
        attach(item)
        player.defaultRate = rate
        seekEpoch += 1
        seekInProgress = false
        chaseTarget = CMTime(seconds: resumeAt, preferredTimescale: 600)
        player.replaceCurrentItem(with: item)
        progressMark = resumeAt
        // الموضع السابق يُطلب عند `readyToPlay` (لا بحث بمعالج قبل أن يجهز العنصر)، والتشغيل بعده.
        pendingResume = resumeAt > 0 ? resumeAt : nil
        wantsPlay = autoplay
        if autoplay, pendingResume == nil { player.play() }
    }

    private func attach(_ item: AVPlayerItem) {
        detach()
        failureHandled = false
        reachedEnd = false
        observations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                let status = item.status
                Task { @MainActor [weak self] in self?.statusChanged(status) }
            },
            player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
                let playing = player.timeControlStatus != .paused
                Task { @MainActor [weak self] in self?.isPlaying = playing }
            },
        ]
        let center = NotificationCenter.default
        notificationTokens = [
            center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.itemFailed() }
            },
            center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.reachedEnd = true }
            },
        ]
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] time in
            let seconds = time.seconds
            MainActor.assumeIsolated { self?.tick(seconds) }
        }
    }

    private func detach() {
        observations.forEach { $0.invalidate() }
        observations = []
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
        notificationTokens = []
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
    }

    private func tick(_ seconds: Double) {
        guard seconds.isFinite else { return }
        if !isScrubbing { currentSeconds = max(0, seconds) }
        if seconds > progressMark + 1 { refreshesWithoutProgress = 0; progressMark = seconds }
        if let d = player.currentItem?.duration, d.isNumeric, d.seconds > 0 { durationSeconds = d.seconds }
    }

    private func statusChanged(_ status: AVPlayerItem.Status) {
        switch status {
        case .readyToPlay:
            phase = .ready
            if let item = player.currentItem {
                if item.duration.isNumeric, item.duration.seconds > 0 { durationSeconds = item.duration.seconds }
                let size = item.presentationSize
                if size.width > 0, size.height > 0 { videoAspect = size.width / size.height }
            }
            resumeWhenReady()
        case .failed:
            itemFailed()
        default:
            break
        }
    }

    /// بعد تحميل عنصر بموضع سابق: البحث إليه الآن والعنصر جاهز (أو إلى موضع السحب إن كان المراسل يسحب)، ثم التشغيل إن أراده.
    private func resumeWhenReady() {
        guard let resume = pendingResume else {
            if wantsPlay, !isScrubbing, player.timeControlStatus == .paused { player.play() }
            return
        }
        pendingResume = nil
        let target = CMTime(seconds: isScrubbing ? scrubSeconds : resume, preferredTimescale: 600)
        chaseTarget = target
        chaseExact = true
        seekInProgress = true
        let epoch = seekEpoch
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, epoch == self.seekEpoch else { return }
                if CMTimeCompare(target, self.chaseTarget) == 0 { self.seekInProgress = false } else { self.seekToChaseTarget() }
                if self.wantsPlay, !self.isScrubbing { self.player.play() }
            }
        }
    }

    /// فشل العنصر: نسخة بعيدة انتهى رابطها أو تعثّرت ← رابط جديد ويُستأنف من الموضع نفسه (`SignedURLRefresh`)، بحدٍّ بلا تقدّم؛
    /// ثم `hls` يرجع مرة واحدة إلى النسخة الخفيفة المتحقَّقة (`PlaybackSourcePolicy.fallback`) قبل «تعذّر التشغيل». والموضع موضع
    /// السحب إن انقطع والمراسل يسحب.
    private func itemFailed() {
        guard !failureHandled else { return }
        failureHandled = true
        let resumeAt = isScrubbing ? scrubSeconds : currentSeconds
        let resume = wantsPlay || (isScrubbing && wasPlayingBeforeScrub)
        guard case .remote = source else { phase = .failed; return }
        switch SignedURLRefresh.afterFailure(lease, now: Date(), refreshesWithoutProgress: refreshesWithoutProgress) {
        case .fetchNew:
            refreshesWithoutProgress += 1
            lease = nil
            Task { await load(resumeAt: resumeAt, autoplay: resume) }
        case .useCurrent, .giveUp:
            guard !usedFallback, let fallback = fallbackSource else { phase = .failed; return }
            usedFallback = true
            source = fallback
            quality = fallback.quality
            lease = nil
            refreshesWithoutProgress = 0
            Task { await load(resumeAt: resumeAt, autoplay: resume) }
        }
    }

    /// يوقف كل شيء ويمحو الرابط والمعاينات من الذاكرة (مغادرة التفاصيل، والمسح الطارئ، والخروج).
    func stop() {
        loadToken = UUID()
        seekEpoch += 1
        wantsPlay = false
        pendingResume = nil
        player.pause()
        detach()
        player.replaceCurrentItem(with: nil)
        lease = nil
        previewTask?.cancel()
        previewTask = nil
        previewFile = nil
        pendingPreview = nil
        scrubPreview = nil
        isScrubbing = false
        isPlaying = false
        currentSeconds = 0
        seekInProgress = false
        chaseTarget = .zero
        phase = .idle
        PlaybackCenter.shared.deactivate(self)
    }
}

// MARK: - مركز التشغيل

/// مشغّل واحد يعمل في كل لحظة، وجلسة الصوت `.playback` ما دام مشغّل نشطًا؛ والمسح الطارئ والخروج والإبطال يوقفون كل شيء.
@MainActor
final class PlaybackCenter {
    static let shared = PlaybackCenter()
    private let players = NSHashTable<PlayerModel>.weakObjects()

    func activate(_ model: PlayerModel) {
        for other in players.allObjects where other !== model { other.pause() }
        players.add(model)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
    }

    func deactivate(_ model: PlayerModel) {
        players.remove(model)
        guard players.allObjects.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// المسح الطارئ والخروج والإبطال: يتوقف التشغيل ويُمحى الرابط والمعاينات، ويعود الاتجاه عموديًا.
    func stopAll() {
        for model in players.allObjects { model.stop() }
        players.removeAllObjects()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        OrientationLock.restorePortrait()
    }
}

// MARK: - الاتجاه

/// التطبيق عمودي؛ ملء الشاشة وحده يسمح بالأفقي (`AppDelegate.application(_:supportedInterfaceOrientationsFor:)`).
@MainActor
enum OrientationLock {
    private(set) static var mask: UIInterfaceOrientationMask = .portrait

    /// يسمح بالتدوير، ويطلب الأفقي لفيديو أفقي فلا يحتاج المراسل إلى تدوير الهاتف وقفل الاتجاه مفعّل.
    static func allowRotation(preferLandscape: Bool) {
        mask = .allButUpsideDown
        refresh(prefer: preferLandscape ? .landscapeRight : nil)
    }

    static func restorePortrait() {
        guard mask != .portrait else { return }
        mask = .portrait
        refresh(prefer: .portrait)
    }

    private static func refresh(prefer: UIInterfaceOrientationMask?) {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows {
                var controller = window.rootViewController
                while let current = controller {
                    current.setNeedsUpdateOfSupportedInterfaceOrientations()
                    controller = current.presentedViewController
                }
            }
            if let prefer { scene.requestGeometryUpdate(.iOS(interfaceOrientations: prefer)) }
        }
    }
}

// MARK: - سطح العرض

/// طبقة AVPlayerLayer بلا أدوات النظام (لا مشاركة ولا صورة داخل صورة)؛ الأدوات في `PlayerControls`.
struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        view.backgroundColor = .black
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

// MARK: - الأدوات

enum PlayerFormat {
    /// «0:37» بلا فراغ للصفر.
    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let text = VLFormat.duration(seconds)
        return text.isEmpty ? "0:00" : text
    }

    static func speed(_ rate: Float) -> String {
        let value = rate == rate.rounded() ? String(Int(rate)) : String(format: "%.1f", rate)
        return "\(value)\u{00D7}"
    }

    /// الجودة مختصرة على الشريط.
    static func shortQuality(_ q: PlaybackQuality) -> Text {
        switch q {
        case .original: return Text("player.quality.short.original")
        case .lightCopy(let lines?): return Text(verbatim: "\(lines)p")
        case .lightCopy(nil): return Text("player.quality.short.light")
        case .adaptive: return Text(verbatim: "HLS")
        }
    }

    /// الجودة كاملة لقارئ الشاشة وفي قائمة الملفات.
    static func quality(_ q: PlaybackQuality) -> Text {
        switch q {
        case .original: return Text("player.quality.original")
        case .lightCopy(let lines?): return Text("player.quality.light \(lines)")
        case .lightCopy(nil): return Text("player.quality.light")
        case .adaptive: return Text("player.quality.adaptive")
        }
    }
}

/// شريط الوقت: LTR دائمًا (الزمن يجري من اليسار في الاتجاهين)، وهدف لمس ≥ 44، وفقاعة معاينة فوق الموضع أثناء السحب،
/// وإيماءة التعديل لقارئ الشاشة تقدّم أو تؤخّر عشر ثوانٍ.
struct PlayerScrubber: View {
    @ObservedObject var model: PlayerModel
    @ScaledMetric(relativeTo: .body) private var thumb: CGFloat = 14

    private var shown: Double { model.isScrubbing ? model.scrubSeconds : model.currentSeconds }
    private var fraction: Double { model.durationSeconds > 0 ? min(max(shown / model.durationSeconds, 0), 1) : 0 }

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.vl.textOnStore.opacity(0.3)).frame(height: VL.Space.s2)
                Capsule().fill(Color.vl.actionPrimary).frame(width: width * fraction, height: VL.Space.s2)
                Circle().fill(Color.vl.textOnStore).frame(width: thumb, height: thumb)
                    .offset(x: width * fraction - thumb / 2)
            }
            .frame(width: width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        model.beginScrub()
                        let x = min(max(value.location.x / max(width, 1), 0), 1)
                        model.scrub(to: x * model.durationSeconds)
                    }
                    .onEnded { _ in model.endScrub() }
            )
            .overlay(alignment: .topLeading) {
                if model.isScrubbing { bubble(width: width) }
            }
        }
        .frame(height: VL.Size.touchMin)
        .environment(\.layoutDirection, .leftToRight)
        .disabled(model.phase != .ready)
        .accessibilityElement()
        .accessibilityLabel(Text("player.seek"))
        .accessibilityValue(Text("player.position \(PlayerFormat.clock(shown)) \(PlayerFormat.clock(model.durationSeconds))"))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: model.seek(by: 10)
            case .decrement: model.seek(by: -10)
            @unknown default: break
            }
        }
    }

    /// فقاعة فوق الموضع: إطار من نسخة الهاتف إن وُجد، والوقت دائمًا.
    private func bubble(width: CGFloat) -> some View {
        let bubbleWidth: CGFloat = model.scrubPreview == nil ? 72 : 128
        let x = min(max(width * fraction - bubbleWidth / 2, 0), max(width - bubbleWidth, 0))
        return VStack(spacing: VL.Space.s1) {
            if let preview = model.scrubPreview {
                preview.resizable().scaledToFit()
                    .frame(maxWidth: bubbleWidth, maxHeight: 96)
                    .clipShape(RoundedRectangle(cornerRadius: VL.Space.s3, style: .continuous))
            }
            Text(verbatim: PlayerFormat.clock(model.scrubSeconds)).vlText(.num).foregroundStyle(Color.vl.textOnStore)
        }
        .padding(VL.Space.s2)
        .frame(width: bubbleWidth + VL.Space.s3)
        .background(Color.vl.bgStore.opacity(0.9), in: RoundedRectangle(cornerRadius: VL.Space.s4, style: .continuous))
        .alignmentGuide(.top) { d in d.height + VL.Space.s2 }
        .offset(x: x)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// أدوات المشغّل (09): شريط الوقت، ثم الوقت والجودة وكتم الصوت وملء الشاشة، ثم إطار للخلف والتشغيل والسرعة وإطار للأمام.
/// كل زرّ ≥ 44 ولقارئ الشاشة اسمه، والأيقونات تكبر مع حجم الخط. الأدوات LTR كما في الإطار، وما حولها يتبع لغة التطبيق.
struct PlayerControls: View {
    @ObservedObject var model: PlayerModel
    let isFullscreen: Bool
    var onFullscreen: () -> Void = {}
    @ScaledMetric(relativeTo: .title) private var playSize: CGFloat = 56

    var body: some View {
        VStack(spacing: VL.Space.s2) {
            PlayerScrubber(model: model)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: VL.Space.s2) {
                    time
                    Spacer(minLength: VL.Space.s3)
                    trailingTools
                }
                VStack(alignment: .leading, spacing: VL.Space.s2) {
                    time
                    trailingTools
                }
            }
            HStack(spacing: VL.Space.s4) {
                Spacer(minLength: 0)
                stepButton(-1)
                playButton
                speedMenu
                stepButton(1)
                Spacer(minLength: 0)
            }
        }
        .foregroundStyle(Color.vl.textOnStore)
        .tint(Color.vl.textOnStore)
        .environment(\.layoutDirection, .leftToRight)
    }

    private var time: some View {
        Text(verbatim: "\(PlayerFormat.clock(model.isScrubbing ? model.scrubSeconds : model.currentSeconds)) / \(PlayerFormat.clock(model.durationSeconds))")
            .vlText(.num)
            .accessibilityHidden(true)
    }

    private var trailingTools: some View {
        HStack(spacing: VL.Space.s2) {
            if let quality = model.quality {
                PlayerFormat.shortQuality(quality)
                    .vlText(.label)
                    .padding(.horizontal, VL.Space.s3)
                    .frame(minHeight: VL.Size.touchMin)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("player.quality"))
                    .accessibilityValue(PlayerFormat.quality(quality))
            }
            toolButton(model.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                       label: model.isMuted ? "player.unmute" : "player.mute") { model.toggleMute() }
            toolButton(isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                       label: isFullscreen ? "player.exitFullscreen" : "player.fullscreen", action: onFullscreen)
        }
    }

    private func toolButton(_ systemImage: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .frame(minWidth: VL.Size.touchMin, minHeight: VL.Size.touchMin)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    private func stepButton(_ count: Int) -> some View {
        Button { model.step(count) } label: {
            Text(verbatim: count < 0 ? "\u{2212}1f" : "+1f")
                .vlText(.num)
                .frame(minWidth: VL.Size.touchMin, minHeight: VL.Size.touchMin)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.phase != .ready)
        .accessibilityLabel(Text(count < 0 ? "player.back" : "player.forward"))
    }

    private var playButton: some View {
        Button { model.togglePlay() } label: {
            ZStack {
                Circle().fill(Color.vl.textOnStore)
                if model.phase == .loading {
                    ProgressView().tint(Color.vl.bgStore)
                } else {
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color.vl.bgStore)
                }
            }
            .frame(width: max(playSize, VL.Size.touchMin), height: max(playSize, VL.Size.touchMin))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(model.isPlaying ? "player.pause" : "player.play"))
    }

    private var speedMenu: some View {
        Menu {
            Picker(selection: Binding(get: { model.rate }, set: { model.setRate($0) })) {
                ForEach(PlayerModel.speeds, id: \.self) { speed in
                    Text(verbatim: PlayerFormat.speed(speed)).tag(speed)
                }
            } label: {
                Text("player.speed")
            }
        } label: {
            Text(verbatim: PlayerFormat.speed(model.rate))
                .vlText(.num)
                .frame(minWidth: VL.Size.touchMin, minHeight: VL.Size.touchMin)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("player.speed"))
        .accessibilityValue(Text(verbatim: PlayerFormat.speed(model.rate)))
    }
}

/// المشغّل داخل التفاصيل (08): الإطار فوق شريط الأدوات على وجه العرض الداكن، بنسبة الفيديو بين 3:4 و16:9.
struct InlinePlayer: View {
    @ObservedObject var model: PlayerModel
    var onFullscreen: () -> Void

    private var aspect: CGFloat { min(max(model.videoAspect ?? 1, 0.75), 16 / 9) }

    var body: some View {
        VStack(spacing: 0) {
            PlayerSurface(player: model.player)
                .aspectRatio(aspect, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .overlay {
                    if model.phase == .failed { PlayerFailureNote(model: model) }
                }
                .accessibilityHidden(model.phase != .failed)
            PlayerControls(model: model, isFullscreen: false, onFullscreen: onFullscreen)
                .padding(.horizontal, VL.Space.s4)
                .padding(.vertical, VL.Space.s3)
        }
        .background(Color.vl.bgStore)
        .clipShape(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .environment(\.colorScheme, .dark)
    }
}

/// «تعذّر التشغيل» بزرّ إعادة المحاولة؛ لا تفاصيل تقنية ولا رابط.
struct PlayerFailureNote: View {
    @ObservedObject var model: PlayerModel

    var body: some View {
        VStack(spacing: VL.Space.s3) {
            Image(systemName: "exclamationmark.triangle").font(.title2).accessibilityHidden(true)
            Text("player.failed").vlText(.body).multilineTextAlignment(.center)
            Button("player.retry") { model.play() }.buttonStyle(.vlOutlineSmall)
        }
        .foregroundStyle(Color.vl.textOnStore)
        .padding(VL.Space.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.vl.bgStore.opacity(0.85))
    }
}

/// المشغّل ملء الشاشة (09)، داكن دائمًا: الإغلاق والعنوان أعلاه، والأدوات أسفله، وتختفي الأدوات بعد ثلاث ثوانٍ من التشغيل
/// (لا تختفي مع قارئ الشاشة، ولا بحركة مع «تقليل الحركة»)؛ اللمس يظهرها. يدور مع الهاتف، والفيديو الأفقي يبدأ أفقيًا.
struct FullscreenPlayer: View {
    @ObservedObject var model: PlayerModel
    let title: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.scenePhase) private var scenePhase
    @State private var controlsShown = true
    @State private var hideTask: Task<Void, Never>?

    private var showsControls: Bool { controlsShown || voiceOver || !model.isPlaying || model.phase != .ready }

    var body: some View {
        ZStack {
            Color.vl.bgStore.ignoresSafeArea()
            PlayerSurface(player: model.player)
                .ignoresSafeArea()
                .accessibilityHidden(true)
                .onTapGesture {
                    VLMotion.animate(reduceMotion) { controlsShown.toggle() }
                    scheduleHide()
                }
            if model.phase == .failed { PlayerFailureNote(model: model) }
            if showsControls {
                VStack(spacing: 0) {
                    HStack(spacing: VL.Space.s3) {
                        VLIconButton(systemImage: "xmark", label: "player.close") { dismiss() }
                        Text(verbatim: title).vlText(.headline).foregroundStyle(Color.vl.textOnStore).lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, VL.Space.s4)
                    .padding(.vertical, VL.Space.s2)
                    .background(Color.vl.bgStore.opacity(0.7))
                    Spacer(minLength: 0)
                    PlayerControls(model: model, isFullscreen: true) { dismiss() }
                        .padding(.horizontal, VL.Space.s4)
                        .padding(.vertical, VL.Space.s3)
                        .background(Color.vl.bgStore.opacity(0.7))
                }
                .transition(.opacity)
            }
        }
        .environment(\.colorScheme, .dark)
        .statusBarHidden(!showsControls)
        .persistentSystemOverlays(showsControls ? .automatic : .hidden)
        .onAppear {
            OrientationLock.allowRotation(preferLandscape: (model.videoAspect ?? 0) > 1.1)
            scheduleHide()
        }
        .onDisappear {
            hideTask?.cancel()
            OrientationLock.restorePortrait()
        }
        // تشغيل أو إيقاف يُظهر الأدوات ثم تختفي بعد ثلاث ثوانٍ إن استمر التشغيل.
        .onChange(of: model.isPlaying) { _, _ in
            controlsShown = true
            scheduleHide()
        }
        // فُتح ملء الشاشة قبل أن يُعرف شكل الفيديو: الأفقي يطلب الأفقي حين يُعرف.
        .onChange(of: model.videoAspect) { _, aspect in
            if let aspect, aspect > 1.1 { OrientationLock.allowRotation(preferLandscape: true) }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.pause() } }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        guard controlsShown, model.isPlaying, !voiceOver else { return }
        hideTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            VLMotion.animate(reduceMotion) { controlsShown = false }
        }
    }
}
