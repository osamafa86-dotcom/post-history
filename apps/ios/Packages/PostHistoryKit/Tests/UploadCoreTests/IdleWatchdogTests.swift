import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif
import UploadCore

/// مراقب الخمول في `URLSessionTusTransport` (مهلة تُقاس على تقدّم إرسال الجسم، لا على زمن الطلب كله):
/// جسم يُقرأ ببطء لكن بتقدّم لا يُلغى، وجسم يتوقف الخادم عن قراءته يُلغى بعد المهلة فيستأنف المحرك من HEAD.
final class IdleWatchdogTests: XCTestCase {
    func testSlowButProgressingPatchIsNotCancelled() async throws {
        let stub = try PacedTusStub(mode: .drain(bytesPerStep: 1 << 20, pauseMs: 10))
        defer { stub.stop() }
        let bytes = 24 << 20
        let (transport, collector, request) = try makePatch(port: stub.port, chunkBytes: bytes, idleTimeout: 2)
        try await transport.schedulePatch(request)
        let outcomes = await collector.wait(count: 1, timeout: 60)
        XCTAssertEqual(outcomes.first?.1, .completed(newOffset: Int64(bytes)))
        XCTAssertEqual(stub.bodyBytesSeen, bytes)
    }

    func testStalledPatchIsCancelledAfterIdleTimeout() async throws {
        let stub = try PacedTusStub(mode: .stallAfter(bytes: 1 << 20))
        defer { stub.stop() }
        let (transport, collector, request) = try makePatch(port: stub.port, chunkBytes: 24 << 20, idleTimeout: 1)
        let t0 = Date()
        try await transport.schedulePatch(request)
        let outcomes = await collector.wait(count: 1, timeout: 30)
        XCTAssertEqual(outcomes.first?.1, .failed(.cancelled))
        // لا إلغاء قبل انقضاء مهلة الخمول نفسها.
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(t0), 1)
        XCTAssertGreaterThanOrEqual(stub.bodyBytesSeen, 1 << 20)
    }

    /// تغيير «Wi‑Fi فقط»: المهمة الجارية تُلغى فيستأنف المحرّك من HEAD بالسياسة الجديدة.
    func testRestartTransfersCancelsPendingPatches() async throws {
        let stub = try PacedTusStub(mode: .stallAfter(bytes: 1 << 20))
        defer { stub.stop() }
        let (transport, collector, request) = try makePatch(port: stub.port, chunkBytes: 8 << 20, idleTimeout: nil)
        try await transport.schedulePatch(request)
        while stub.bodyBytesSeen < 1 << 20 { try await Task.sleep(nanoseconds: 20_000_000) }
        await transport.restartTransfers()
        let outcomes = await collector.wait(count: 1, timeout: 10)
        XCTAssertEqual(outcomes.first?.1, .failed(.cancelled))
        XCTAssertTrue(TusError.cancelled.isRetryable, "the engine resumes from the server offset")
    }

    #if canImport(Darwin)
    func testUnmeteredOnlyForbidsExpensiveAndConstrainedNetworks() {
        var r = URLRequest(url: URL(string: "https://ingest.example.invalid/files/x")!)
        URLSessionTusTransport.applyNetworkPolicy(&r, unmeteredOnly: true)
        XCTAssertFalse(r.allowsExpensiveNetworkAccess)
        XCTAssertFalse(r.allowsConstrainedNetworkAccess)
        URLSessionTusTransport.applyNetworkPolicy(&r, unmeteredOnly: false)
        XCTAssertTrue(r.allowsExpensiveNetworkAccess)
        XCTAssertTrue(r.allowsConstrainedNetworkAccess)
    }
    #endif

    private func makePatch(port: UInt16, chunkBytes: Int, idleTimeout: TimeInterval?) throws
        -> (URLSessionTusTransport, TusdLiveTests.Collector, TusPatchRequest) {
        let dir = Fixtures.tempDir("watchdog")
        let chunkFile = dir.appendingPathComponent("chunk.bin")
        try Data(count: chunkBytes).write(to: chunkFile)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 600
        let transport = URLSessionTusTransport(configuration: config, idleTimeout: idleTimeout)
        let collector = TusdLiveTests.Collector()
        let id = UUID()
        let request = TusPatchRequest(
            key: TusTaskKey(uploadId: id, offset: 0),
            uploadURL: URL(string: "http://127.0.0.1:\(port)/files/stub")!,
            token: "t",
            chunk: PreparedChunk(offset: 0, length: Int64(chunkBytes), fileName: "chunk.bin"),
            chunkFile: chunkFile)
        let semaphore = DispatchSemaphore(value: 0)
        Task { await transport.setDelegate(collector); semaphore.signal() }
        semaphore.wait()
        return (transport, collector, request)
    }
}

/// خادم tus مصغّر على مقبس POSIX يتحكم بوتيرة قراءة جسم PATCH: يقرأ ببطء مع تقدّم، أو يتوقف تمامًا بعد عدد من البايتات.
/// نافذة الاستقبال صغيرة كي يتوقف المرسل سريعًا حين لا نقرأ، ولا يسبق القراءة بأكثر من بضع مئات من الكيلوبايتات حين نقرأ.
final class PacedTusStub: @unchecked Sendable {
    enum Mode { case drain(bytesPerStep: Int, pauseMs: UInt32), stallAfter(bytes: Int) }
    enum StubError: Error { case socket, bind }

    let mode: Mode
    private(set) var port: UInt16 = 0
    private var fd: Int32 = -1
    private let lock = NSLock()
    private var stopped = false
    private var seen = 0
    var bodyBytesSeen: Int { lock.withLock { seen } }

    init(mode: Mode) throws {
        self.mode = mode
        signal(SIGPIPE, SIG_IGN)
        #if os(Linux)
        fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #else
        fd = socket(AF_INET, SOCK_STREAM, 0)
        #endif
        guard fd >= 0 else { throw StubError.socket }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var rcv: Int32 = 32 * 1024
        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        #if canImport(Darwin)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 4) == 0 else { throw StubError.bind }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        port = UInt16(bigEndian: addr.sin_port)
        Thread { [self] in self.acceptLoop() }.start()
    }

    func stop() {
        lock.withLock { stopped = true }
        shutdown(fd, Int32(SHUT_RDWR))
        close(fd)
    }

    private var isStopped: Bool { lock.withLock { stopped } }

    private func acceptLoop() {
        while !isStopped {
            let c = accept(fd, nil, nil)
            if c < 0 { return }
            Thread { [self] in self.handle(c) }.start()
        }
    }

    private func handle(_ c: Int32) {
        defer { close(c) }
        var buf = [UInt8](repeating: 0, count: 1 << 20)
        var head = [UInt8]()
        var body = [UInt8]()
        while true {
            let n = recv(c, &buf, buf.count, 0)
            if n <= 0 { return }
            head.append(contentsOf: buf[0..<n])
            if let r = head.firstRange(of: [13, 10, 13, 10]) {
                body = Array(head[r.upperBound...])
                head = Array(head[..<r.lowerBound])
                break
            }
        }
        let lines = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")
        let method = lines.first?.split(separator: " ").first.map(String.init) ?? ""
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let i = line.firstIndex(of: ":") else { continue }
            headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        if headers["expect"]?.lowercased() == "100-continue" { write(c, "HTTP/1.1 100 Continue\r\n\r\n") }
        guard method == "PATCH" else { write(c, "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"); return }
        let length = headers["content-length"].flatMap(Int.init) ?? 0
        let offset = headers["upload-offset"].flatMap(Int.init) ?? 0
        var got = body.count
        switch mode {
        case .stallAfter(let bytes):
            while got < bytes {
                let n = recv(c, &buf, min(buf.count, bytes - got), 0)
                if n <= 0 { return }
                got += n
            }
            lock.withLock { seen = got }
            // لا نقرأ شيئًا بعد ذلك ولا نجيب؛ ننتظر إلغاء العميل.
            while !isStopped { usleep(100_000) }
        case .drain(let step, let pauseMs):
            while got < length {
                var stepGot = 0
                while stepGot < step, got < length {
                    let n = recv(c, &buf, min(buf.count, step - stepGot, length - got), 0)
                    if n <= 0 { return }
                    stepGot += n
                    got += n
                }
                lock.withLock { seen = got }
                usleep(pauseMs * 1000)
            }
            write(c, "HTTP/1.1 204 No Content\r\nTus-Resumable: 1.0.0\r\nUpload-Offset: \(offset + length)\r\nContent-Length: 0\r\n\r\n")
        }
    }

    private func write(_ c: Int32, _ s: String) {
        let bytes = Array(s.utf8)
        _ = bytes.withUnsafeBufferPointer { send(c, $0.baseAddress, $0.count, 0) }
    }
}
