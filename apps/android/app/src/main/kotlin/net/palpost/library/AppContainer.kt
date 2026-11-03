package net.palpost.library

import net.palpost.library.core.upload.IngestTokens
import net.palpost.library.upload.PlayIntegrityAttester
import android.content.Context
import net.palpost.library.api.apis.EarningsApi
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.apis.FormsApi
import net.palpost.library.api.apis.MaterialsApi
import net.palpost.library.api.apis.NotificationsApi
import net.palpost.library.api.apis.UploadsApi
import net.palpost.library.auth.KeystoreSealer
import net.palpost.library.auth.KeystoreTokenStore
import net.palpost.library.core.auth.AuthManager
import net.palpost.library.core.auth.TokenStore
import net.palpost.library.core.upload.FileSource
import net.palpost.library.data.RoomUploadStore
import net.palpost.library.data.FileSendBatchStore
import net.palpost.library.data.ReporterMemoryStore
import net.palpost.library.data.LocalAccountsStore
import net.palpost.library.core.auth.AuthState
import net.palpost.library.core.upload.AccountScope
import net.palpost.library.core.upload.LocalAccounts
import net.palpost.library.ui.material.MaterialsRepository
import net.palpost.library.ui.material.PlaybackCenter
import net.palpost.library.ui.material.ThumbnailCache
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import net.palpost.library.core.send.SendBatchLedger
import net.palpost.library.ui.receipt.ReceiptCenter
import net.palpost.library.data.UploadDatabase
import net.palpost.library.upload.ContentResolverFileSource
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Hand-wired dependencies. One instance per process, owned by [PostHistoryApp]. */
class AppContainer(context: Context) {
    private val app = context.applicationContext
    val baseUrl: String = BuildConfig.API_BASE_URL.trimEnd('/')
    val sealer = KeystoreSealer("net.palpost.library.session")
    val tokenStore: TokenStore = KeystoreTokenStore(app, sealer)

    // No logging interceptor and no disk cache anywhere: request and response bodies carry tokens and material
    // metadata. (tus-java-client uses HttpURLConnection, which caches nothing: no ResponseCache is installed.)
    private val httpClient = OkHttpClient.Builder()
        .cache(null)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    val auth = AuthManager(baseUrl, tokenStore, httpClient)
    val authApi: AuthApi by lazy { AuthApi(baseUrl, auth.authenticatedClient) }
    val earningsApi: EarningsApi by lazy { EarningsApi(baseUrl, auth.authenticatedClient) }
    val formsApi: FormsApi by lazy { FormsApi(baseUrl, auth.authenticatedClient) }
    val materialsApi: MaterialsApi by lazy { MaterialsApi(baseUrl, auth.authenticatedClient) }
    val notificationsApi: NotificationsApi by lazy { NotificationsApi(baseUrl, auth.authenticatedClient) }
    val uploadsApi: UploadsApi by lazy { UploadsApi(baseUrl, auth.authenticatedClient) }

    // Re-openable: a wipe closes and deletes the database; the next sign-in gets a fresh one without restarting.
    @Volatile private var db: UploadDatabase? = null
    val database: UploadDatabase
        get() = synchronized(this) { db?.takeIf { it.isOpen } ?: UploadDatabase.open(app).also { db = it } }
    val uploadStore: RoomUploadStore get() = RoomUploadStore(database.uploads(), sealer)
    val fileSource: FileSource by lazy { ContentResolverFileSource(app) }
    /** Gate tokens for uploads behind the ingest gate (SEC-07); one cache per process. */
    val ingestTokens: IngestTokens by lazy {
        IngestTokens(uploadsApi, BuildConfig.PLAY_CLOUD_PROJECT_NUMBER.takeIf { it > 0 }?.let { PlayIntegrityAttester(app, it) })
    }
    val settings: AppSettings by lazy { AppSettings(app) }

    /** The reporter's last place, display name and earlier tags (never coordinates); erased on sign-out, revocation and wipe. */
    val reporterMemory: ReporterMemoryStore by lazy { ReporterMemoryStore(java.io.File(app.noBackupFilesDir, "reporter-memory.json")) }

    /** The sends of the send screen and their one receipt each (ADR 0088); erased on sign-out, revocation and wipe. */
    val sendBatches: SendBatchLedger by lazy { SendBatchLedger(FileSendBatchStore(java.io.File(app.noBackupFilesDir, "send-batches.json"))) }

    /** Decides when a receipt shows: once per send when its last file arrives, or per material outside a send. */
    val receipts: ReceiptCenter by lazy { ReceiptCenter(this) }

    /** My materials (ADR 0089): one feed for the app, cleared on sign-out, revocation and wipe. */
    val materials: MaterialsRepository by lazy { MaterialsRepository { materialsApi } }

    /**
     * Thumbnails of verified derivatives, through signed links that are never kept: a plain client (no session header: the link
     * is the authorisation) without a cache, memory only.
     */
    val thumbnails: ThumbnailCache by lazy { ThumbnailCache(httpClient) }

    /** The players on screen: stopped together on sign-out, revocation and wipe. */
    val playback = PlaybackCenter()

    // ADR 0093: whom the rows, sends and receipts belong to, by an opaque local id per account (never its email or server id).
    private val accountsStore = LocalAccountsStore(java.io.File(app.noBackupFilesDir, "local-accounts"))
    private val accountsLock = Any()
    private var accounts: LocalAccounts? = null
    private val _scope = MutableStateFlow(AccountScope())
    /** The signed-in account and the sole one, set before the queue resumes at launch (ADR 0093 §4). */
    val scope: StateFlow<AccountScope> = _scope

    /**
     * Follows the session: a sign-in registers the account on its first sign-in here. An accounts file that cannot be read gives a
     * scope with nobody (nothing shown, nothing asked in anyone's name) and is never written over; the next change reads it again.
     */
    fun updateScope(state: AuthState) = synchronized(accountsLock) {
        val known = accounts ?: accountsStore.load()
        if (known == null) { _scope.value = AccountScope(); return@synchronized }
        val user = (state as? AuthState.SignedIn)?.userId
        var next = known
        if (user != null) {
            val (record, _) = known.register(user)
            if (record != known && !accountsStore.save(record)) { _scope.value = AccountScope(); return@synchronized }
            next = record
        }
        accounts = next
        _scope.value = next.scope(user)
    }

    /** The emergency wipe, with the queue: the record and its file go; the next sign-in starts a fresh one. */
    fun forgetAccounts() = synchronized(accountsLock) {
        accountsStore.delete()
        accounts = null
        _scope.value = AccountScope()
    }

    init { updateScope(auth.state.value) }
}
