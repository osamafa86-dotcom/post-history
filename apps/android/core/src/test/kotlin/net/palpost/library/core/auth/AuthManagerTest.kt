package net.palpost.library.core.auth

import kotlinx.coroutines.runBlocking
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.infrastructure.ClientException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AuthManagerTest {
    private val server = MockWebServer()
    private val store = InMemoryTokenStore()
    private var now = 1_700_000_000_000L
    private lateinit var manager: AuthManager
    private lateinit var me: AuthApi

    @Before fun start() {
        server.start()
        manager = AuthManager(server.url("/v1").toString().trimEnd('/'), store, clock = { now })
        me = AuthApi(server.url("/v1").toString().trimEnd('/'), manager.authenticatedClient)
    }

    @After fun stop() = server.shutdown()

    private fun sessionJson(access: String, refresh: String, expiresInMs: Long = 900_000) = """
        {"access_token":"$access","refresh_token":"$refresh","expires_at":"${OffsetDateTime.ofInstant(Instant.ofEpochMilli(now + expiresInMs), ZoneOffset.UTC)}",
         "user_id":"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","roles":[{"name":"reporter","scopes":[]}]}
    """.trimIndent()

    private val meJson = """{"user_id":"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","email":"r@example.invalid","roles":[],"permissions":[],"totp_enabled":true}"""
    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    private val unauthorized = json(401, """{"code":"unauthorized","message":"no","request_id":"r1"}""")

    @Test fun `login stores tokens, sends no bearer, and signs in`() = runBlocking {
        server.enqueue(json(200, sessionJson("a1", "r1")))
        manager.login("r@example.invalid", "password123", "123456")
        val req = server.takeRequest()
        assertEquals("/v1/auth/login", req.path)
        assertNull(req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().contains("\"totp_code\":\"123456\""))
        assertEquals("a1", store.read()?.accessToken)
        assertEquals(AuthState.SignedIn("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), manager.state.value)
    }

    @Test fun `authenticated call carries the bearer`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(json(200, meJson))
        me.getMe()
        assertEquals("Bearer a1", server.takeRequest().getHeader("Authorization"))
    }

    @Test fun `a lapsing access token is rotated before the call`() = runBlocking {
        store.write(SessionTokens("old", "r1", now + 10_000, "u"))
        server.enqueue(json(200, sessionJson("new", "r2")))
        server.enqueue(json(200, meJson))
        me.getMe()
        val refresh = server.takeRequest()
        assertEquals("/v1/auth/refresh", refresh.path)
        assertNull(refresh.getHeader("Authorization"))
        assertTrue(refresh.body.readUtf8().contains("\"refresh_token\":\"r1\""))
        assertEquals("Bearer new", server.takeRequest().getHeader("Authorization"))
        assertEquals("r2", store.read()?.refreshToken)
    }

    @Test fun `a 401 is answered by one refresh and one retry`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(unauthorized)
        server.enqueue(json(200, sessionJson("a2", "r2")))
        server.enqueue(json(200, meJson))
        me.getMe()
        assertEquals("Bearer a1", server.takeRequest().getHeader("Authorization"))
        assertEquals("/v1/auth/refresh", server.takeRequest().path)
        assertEquals("Bearer a2", server.takeRequest().getHeader("Authorization"))
        assertEquals(3, server.requestCount)
    }

    @Test fun `a refused refresh revokes the session locally`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(unauthorized)
        server.enqueue(unauthorized)
        try {
            me.getMe(); fail("expected 401")
        } catch (e: ClientException) {
            assertEquals(401, e.statusCode)
        }
        assertNull(store.read())
        assertEquals(AuthState.SignedOut(SignOutReason.SESSION_REVOKED), manager.state.value)
        assertEquals(2, server.requestCount)
    }

    @Test fun `a revoked session is rejected locally within the same call, measured`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(unauthorized)
        server.enqueue(unauthorized)
        val started = System.nanoTime()
        try { me.getMe(); fail("expected 401") } catch (e: ClientException) { assertEquals(401, e.statusCode) }
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        println("MEASUREMENT revoked-token-rejected-locally-ms=$elapsedMs")
        assertNull(store.read())
        assertEquals(AuthState.SignedOut(SignOutReason.SESSION_REVOKED), manager.state.value)
        assertTrue("local revocation took ${'$'}elapsedMs ms", elapsedMs < 2_000)
    }

    @Test fun `a second 401 after the retry is final`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(unauthorized)
        server.enqueue(json(200, sessionJson("a2", "r2")))
        server.enqueue(unauthorized)
        try {
            me.getMe(); fail("expected 401")
        } catch (e: ClientException) {
            assertEquals(401, e.statusCode)
        }
        assertEquals(3, server.requestCount)
        assertEquals("a2", store.read()?.accessToken) // the session itself still stands
    }

    @Test fun `concurrent callers share one refresh`() {
        store.write(SessionTokens("old", "r1", now, "u"))
        val refreshes = AtomicInteger()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
                if (request.path == "/v1/auth/refresh") { refreshes.incrementAndGet(); Thread.sleep(100); json(200, sessionJson("new", "r2")) }
                else if (request.getHeader("Authorization") == "Bearer new") json(200, meJson)
                else unauthorized
        }
        val pool = Executors.newFixedThreadPool(4)
        val done = CountDownLatch(4)
        val failures = AtomicInteger()
        repeat(4) { pool.execute { try { runBlocking { me.getMe() } } catch (e: Throwable) { failures.incrementAndGet() } finally { done.countDown() } } }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        pool.shutdown()
        assertEquals(0, failures.get())
        assertEquals(1, refreshes.get())
    }

    @Test fun `logout ends the server session with the bearer and no idempotency key`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(MockResponse().setResponseCode(204))
        manager.logout(allSessions = true)
        val req = server.takeRequest()
        assertEquals("/v1/auth/logout", req.path)
        assertEquals("Bearer a1", req.getHeader("Authorization"))
        assertNull(req.getHeader("Idempotency-Key"))
        assertTrue(req.body.readUtf8().contains("\"all_sessions\":true"))
        assertNull(store.read())
    }

    @Test fun `the session bearer never leaves the API host and foreign credentials are left alone`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        val other = MockWebServer().also { it.start() }
        try {
            other.enqueue(unauthorized)
            other.enqueue(unauthorized)
            val call = manager.authenticatedClient.newCall(okhttp3.Request.Builder().url(other.url("/v1/auth/me")).build()).execute()
            assertEquals(401, call.code)
            assertNull(other.takeRequest().getHeader("Authorization"))
            assertEquals(1, other.requestCount) // no refresh, no retry for another host
            // A caller-supplied credential on the API host is sent as is and not swapped for the session on 401.
            server.enqueue(unauthorized)
            val own = manager.authenticatedClient.newCall(okhttp3.Request.Builder().url(server.url("/v1/auth/me")).header("Authorization", "Bearer upload-token").build()).execute()
            assertEquals(401, own.code)
            assertEquals("Bearer upload-token", server.takeRequest().getHeader("Authorization"))
            assertEquals(1, server.requestCount)
            assertEquals("a1", store.read()?.accessToken)
        } finally { other.shutdown() }
    }

    @Test fun `tokens never print`() {
        val s = SessionTokens("secret-access", "secret-refresh", 1L, "u").toString()
        assertTrue(!s.contains("secret"))
    }

    @Test fun `best-effort revocation before a wipe is bounded and never fails the caller`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(MockResponse().setResponseCode(204))
        assertTrue(manager.revokeAllSessionsBestEffort())
        val req = server.takeRequest()
        assertEquals("/v1/auth/logout", req.path)
        assertEquals("Bearer a1", req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().contains("\"all_sessions\":true"))
        assertEquals("a1", store.read()?.accessToken) // local state untouched: the wipe erases it in parallel

        server.enqueue(MockResponse().setResponseCode(204).setHeadersDelay(5, TimeUnit.SECONDS))
        val started = System.nanoTime()
        assertEquals(false, manager.revokeAllSessionsBestEffort(timeoutMs = 300))
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)

        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(false, manager.revokeAllSessionsBestEffort())
    }

    @Test fun `best-effort revocation rotates a lapsed access token first`() = runBlocking {
        store.write(SessionTokens("old", "r1", now + 5_000, "u"))
        server.enqueue(json(200, sessionJson("new", "r2")))
        server.enqueue(MockResponse().setResponseCode(204))
        assertTrue(manager.revokeAllSessionsBestEffort())
        assertEquals("/v1/auth/refresh", server.takeRequest().path)
        val logout = server.takeRequest()
        assertEquals("/v1/auth/logout", logout.path)
        assertEquals("Bearer new", logout.getHeader("Authorization"))
    }

    @Test fun `logout clears the device even when the server is unreachable`() = runBlocking {
        store.write(SessionTokens("a1", "r1", now + 600_000, "u"))
        server.enqueue(MockResponse().setResponseCode(500))
        manager.logout()
        assertNull(store.read())
        assertEquals(AuthState.SignedOut(SignOutReason.USER), manager.state.value)
    }

    @Test fun `the session client never caches API responses on disk, even when handed a client that does`() {
        val dir = java.nio.file.Files.createTempDirectory("okcache").toFile().apply { deleteOnExit() }
        val cached = okhttp3.OkHttpClient.Builder().cache(okhttp3.Cache(dir, 1024 * 1024)).build()
        val m = AuthManager(server.url("/v1").toString().trimEnd('/'), store, httpClient = cached, clock = { now })
        org.junit.Assert.assertNull(m.authenticatedClient.cache)
        org.junit.Assert.assertNull(manager.authenticatedClient.cache)
        org.junit.Assert.assertNull(java.net.ResponseCache.getDefault())
    }
}
