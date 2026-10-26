#if canImport(AVFoundation)
import AVFoundation
import XCTest
@testable import MediaCore

/// النسخة الخفيفة على ملف فيديو اصطناعي بمعدل إطارات متغير (macOS في CI): الأبعاد، وتوقيت كل إطار كما في الأصل، و`start_pts` في البيانات.
final class AVFoundationProxyTranscoderTests: XCTestCase {
    /// أزمنة إطارات غير منتظمة كما في ملفات الهواتف (بالمللي ثانية).
    static let frameTimesMs: [Int64] = (0..<60).map { i in Int64(i) * 33 + (i % 3 == 0 ? 7 : 0) }

    private func makeSource(_ url: URL, width: Int = 1280, height: Int = 720) async throws {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for (i, ms) in Self.frameTimesMs.enumerated() {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            let pb = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pb, [])
            memset(CVPixelBufferGetBaseAddress(pb), Int32(i * 4 % 255), CVPixelBufferGetDataSize(pb))
            CVPixelBufferUnlockBaseAddress(pb, [])
            XCTAssertTrue(adaptor.append(pb, withPresentationTime: CMTime(value: ms, timescale: 1000)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed)
    }

    private func frameTimes(_ url: URL) async throws -> [Double] {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(out)
        XCTAssertTrue(reader.startReading())
        var times: [Double] = []
        while let sample = out.copyNextSampleBuffer() {
            if CMSampleBufferGetNumSamples(sample) > 0 { times.append(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))) }
        }
        return times.sorted()
    }

    func testUrgentProxyIsScaledKeepsSourceFrameTimingAndCarriesStartPts() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("proxy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("source.mov")
        let output = dir.appendingPathComponent("proxy.mov")
        try await makeSource(source)

        let result = try await AVFoundationProxyTranscoder().makeProxy(source: source, preset: .urgent, output: output)
        XCTAssertEqual(result.width, 640)
        XCTAssertEqual(result.height, 360)

        let asset = AVURLAsset(url: output)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 640, height: 360))

        // كل إطار في النسخة على زمن عرض إطار الأصل نفسه (معدل متغير، بلا إعادة أخذ عينات). التركيب يقرّب إلى 1/600 ث،
        // فالفارق ≤ 2 مللي ثانية (الخطة تقبل 40). المرجع أزمنة العرض المكتوبة، لا أزمنة عينات المسار الخام.
        let dst = try await frameTimes(output)
        XCTAssertEqual(dst.count, Self.frameTimesMs.count)
        for (ms, b) in zip(Self.frameTimesMs, dst) { XCTAssertEqual(Double(ms) / 1000, b, accuracy: 0.002) }

        let metadata = try await asset.load(.metadata)
        let start = metadata.first { ($0.key as? String) == proxyStartPtsMetadataKey }
        let value = try await start?.load(.stringValue)
        XCTAssertEqual(value, String(result.sourceStartPtsUs))
    }

    func testFileWithoutVideoIsRejected() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("proxy-none-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let text = dir.appendingPathComponent("note.mov")
        try Data("not a movie".utf8).write(to: text)
        do {
            _ = try await AVFoundationProxyTranscoder().makeProxy(source: text, preset: .urgent, output: dir.appendingPathComponent("out.mov"))
            XCTFail("expected an error")
        } catch {}
    }
}
#endif
