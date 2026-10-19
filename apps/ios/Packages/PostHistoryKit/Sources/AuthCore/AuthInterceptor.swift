import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PostHistoryAPI

/// يضيف `Authorization: Bearer` لكل طلب يحتاج مصادقة، وعند `401` يحدّث الجلسة مرة واحدة ويعيد الطلب.
/// المحاولة الثانية بـ `401` تمرّ كخطأ إلى المستدعي (الجلسة أُبطلت من الإدارة أو انتهت).
public final class AuthInterceptor: OpenAPIInterceptor, @unchecked Sendable {
    private let auth: AuthSession
    private let lock = NSLock()
    private var attempts: [ObjectIdentifier: Int] = [:]

    public init(auth: AuthSession) { self.auth = auth }

    public func intercept<T>(urlRequest: URLRequest, urlSession: URLSessionProtocol, requestBuilder: RequestBuilder<T>, completion: @Sendable @escaping (Result<URLRequest, any Error>) -> Void) {
        guard requestBuilder.requiresAuthentication else { return completion(.success(urlRequest)) }
        let retried = lock.withLock { attempts[ObjectIdentifier(requestBuilder)] ?? 0 } > 0
        Task {
            do {
                var request = urlRequest
                request.setValue("Bearer \(try await auth.validAccessToken(force: retried))", forHTTPHeaderField: "Authorization")
                completion(.success(request))
            } catch {
                completion(.failure(error))
            }
        }
    }

    public func retry<T>(urlRequest: URLRequest, urlSession: URLSessionProtocol, requestBuilder: RequestBuilder<T>, data: Data?, response: URLResponse?, error: any Error, completion: @Sendable @escaping (OpenAPIInterceptorRetry) -> Void) {
        guard requestBuilder.requiresAuthentication, (response as? HTTPURLResponse)?.statusCode == 401 else { return completion(.dontRetry) }
        let key = ObjectIdentifier(requestBuilder)
        let attempt = lock.withLock { attempts[key, default: 0] += 1; return attempts[key]! }
        completion(attempt == 1 ? .retry : .dontRetry)
    }

    public func didComplete<T>(urlRequest: URLRequest, urlSession: URLSessionProtocol, requestBuilder: RequestBuilder<T>, data: Data?, response: URLResponse?, result: Result<T, any Error>) {
        lock.withLock { _ = attempts.removeValue(forKey: ObjectIdentifier(requestBuilder)) }
    }
}
