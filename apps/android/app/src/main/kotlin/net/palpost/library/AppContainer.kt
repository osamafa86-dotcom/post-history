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
}
