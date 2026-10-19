package net.palpost.library

import android.content.Context
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.apis.FormsApi
import net.palpost.library.api.apis.MaterialsApi
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

    // No logging interceptor anywhere: request and response bodies carry tokens and material metadata.
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    val auth = AuthManager(baseUrl, tokenStore, httpClient)
    val authApi: AuthApi by lazy { AuthApi(baseUrl, auth.authenticatedClient) }
    val formsApi: FormsApi by lazy { FormsApi(baseUrl, auth.authenticatedClient) }
    val materialsApi: MaterialsApi by lazy { MaterialsApi(baseUrl, auth.authenticatedClient) }
    val uploadsApi: UploadsApi by lazy { UploadsApi(baseUrl, auth.authenticatedClient) }

    val database: UploadDatabase by lazy { UploadDatabase.open(app) }
    val uploadStore: RoomUploadStore by lazy { RoomUploadStore(database.uploads(), sealer) }
    val fileSource: FileSource by lazy { ContentResolverFileSource(app) }
    val settings: AppSettings by lazy { AppSettings(app) }
}
