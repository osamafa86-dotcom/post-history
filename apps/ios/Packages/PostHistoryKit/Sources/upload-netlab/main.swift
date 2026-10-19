// عميل قياس netlab لنواة الرفع (UploadCore) على Linux.
//   upload-netlab --file <path> --endpoint http://127.0.0.1:18082/files/ --chunk-bytes 1048576 --timeout-s 60 --max-seconds 2400
// يطبع في النهاية سطر JSON واحدًا بالملخص الذي يحوّله tools/netlab/netlab.py (--client-cmd) إلى مقاييسه؛ التشخيص على stderr.
// لا يحتاج خادم API: جلسة الرفع تُستبدل ببديل محلي لأن netlab يقيس مسار tus وحده (toxiproxy → tusd-proxy → tusd → MinIO).
import Foundation
import PostHistoryAPI
import UploadCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct Options {
    var file = ""
    var endpoint = ""
    var chunkBytes: Int64 = 1 << 20
    var timeoutSeconds: Double = 60
    var maxSeconds: Double = 7200
    var token = "netlab"

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 1
        func next() -> String { i += 1; return i < args.count ? args[i] : "" }
        while i < args.count {
            switch args[i] {
            case "--file": o.file = next()
            case "--endpoint": o.endpoint = next()
            case "--chunk-bytes": o.chunkBytes = Int64(next()) ?? o.chunkBytes
            case "--timeout-s": o.timeoutSeconds = Double(next()) ?? o.timeoutSeconds
            case "--max-seconds": o.maxSeconds = Double(next()) ?? o.maxSeconds
            case "--token": o.token = next()
            default: break
            }
            i += 1
        }
        return o
    }
}

/// بديل محلي لـ /uploads: يعيد جلسة تشير إلى نقطة tus المعطاة ويعتبر الرفع متحققًا فور اكتماله (netlab يتحقق من البصمة بنفسه عبر MinIO).
final class NetlabStubAPI: UploadAPI, @unchecked Sendable {
    let endpoint: String
    let token: String
    let sessionId = UUID()
    init(endpoint: String, token: String) { self.endpoint = endpoint; self.token = token }

    func createSession(idempotencyKey: String, _ body: UploadSessionCreate) async throws -> UploadSessionCreated {
        UploadSessionCreated(id: sessionId, materialId: body.materialId, kind: .original, state: .created, sizeBytes: body.sizeBytes,
                             tusEndpoint: endpoint, tusMetadata: UploadSessionTusMetadata(uploadSessionId: sessionId), partSizeBytes: 16 << 20,
                             bytesReceived: 0, expiresAt: Date().addingTimeInterval(86400), createdAt: Date(), uploadToken: token,
                             uploadTokenExpiresAt: Date().addingTimeInterval(86400))
    }
    func session(id: UUID) async throws -> UploadSession {
        UploadSession(id: id, materialId: UUID(), kind: .original, state: .verified, sizeBytes: 1, tusEndpoint: endpoint,
                      tusMetadata: UploadSessionTusMetadata(uploadSessionId: id), partSizeBytes: 16 << 20, bytesReceived: 1, expiresAt: Date(),
                      receiptNumber: "R-000000-000000", createdAt: Date())
    }
    func complete(idempotencyKey: String, id: UUID, reportedSha256: String?) async throws {}
}

func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

let options = Options.parse(CommandLine.arguments)
guard !options.file.isEmpty, let _ = URL(string: options.endpoint) else {
    log("usage: upload-netlab --file <path> --endpoint <tus create url> [--chunk-bytes N] [--timeout-s N] [--max-seconds N]")
    exit(2)
}

let config = URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = options.timeoutSeconds      // مهلة خمول المقبس كما في netlab.py --timeout-s
config.timeoutIntervalForResource = options.maxSeconds + 60
config.httpMaximumConnectionsPerHost = 1
let recorder = RecordingTransport(inner: URLSessionTusTransport(configuration: config))

var policy = ChunkSizePolicy()
policy.foregroundBytes = options.chunkBytes
policy.preparedWindow = 2
var timing = UploadEngine.Timing()
timing.retryDelays = [1, 2, 4, 8, 10]       // تراجع أسي بسقف 10 ث كما في netlab.py
timing.receiptPollInterval = 0.1
var env = UploadEngine.Environment()
env.isBackground = { false }

let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("upload-netlab-\(UUID().uuidString)")
let engine = UploadEngine(store: InMemoryUploadStateStore(), secrets: InMemoryUploadSecretStore(),
                          api: NetlabStubAPI(endpoint: options.endpoint, token: options.token), transport: recorder,
                          slicer: ChunkSlicer(chunksDirectory: workDir), policy: policy, timing: timing, environment: env)

let size = (try? FileManager.default.attributesOfItem(atPath: options.file)[.size] as? NSNumber)?.int64Value ?? 0
let started = Date()
let semaphore = DispatchSemaphore(value: 0)
var finalPhase: UploadPhase?
var finalOffset: Int64 = 0

Task {
    await engine.resumeAll()
    let events = await engine.events()
    let record = try await engine.enqueue(sourcePath: options.file, materialId: UUID(), kind: .original, filename: "netlab.bin", mimeType: "application/octet-stream")
    let deadline = Task {
        try await Task.sleep(nanoseconds: UInt64(options.maxSeconds * 1_000_000_000))
        log("time box reached; cancelling")
        await engine.cancel(record.id)
    }
    for await event in events {
        switch event {
        case .progress(_, let offset, _): log("progress \(offset)/\(size)")
        case .retryScheduled(_, let attempt, let after): log("retry \(attempt) in \(after)s")
        case .phaseChanged(_, let phase):
            log("phase \(phase)")
            if phase.isTerminal { finalPhase = phase; break }
        }
        if finalPhase != nil { break }
    }
    deadline.cancel()
    finalOffset = await engine.record(record.id)?.confirmedOffset ?? 0
    semaphore.signal()
}
semaphore.wait()

let complete: Bool = { if case .verified = finalPhase { return true } else { return false } }()
let summary = recorder.summary(complete: complete, finalOffset: max(finalOffset, recorder.confirmed))
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
print(String(decoding: try encoder.encode(summary), as: UTF8.self))
log("done in \(Int(Date().timeIntervalSince(started)))s, phase \(String(describing: finalPhase))")
try? FileManager.default.removeItem(at: workDir)
exit(complete ? 0 : 3)
