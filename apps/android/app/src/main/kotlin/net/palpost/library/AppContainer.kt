package net.palpost.library

import android.content.Context
import net.palpost.library.api.apis.AuthApi
import net.palpost.library.api.apis.FormsApi
import net.palpost.library.auth.KeystoreTokenStore
import net.palpost.library.core.auth.AuthManager
import net.palpost.library.core.auth.TokenStore
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Hand-wired dependencies. One instance per process, owned by [PostHistoryApp]. */
class AppContainer(context: Context) {
    val baseUrl: String = BuildConfig.API_BASE_URL.trimEnd('/')
    val tokenStore: TokenStore = KeystoreTokenStore(context.applicationContext)

    // No logging interceptor anywhere: request and response bodies carry tokens and material metadata.
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    val auth = AuthManager(baseUrl, tokenStore, httpClient)
    val authApi: AuthApi by lazy { AuthApi(baseUrl, auth.authenticatedClient) }
    val formsApi: FormsApi by lazy { FormsApi(baseUrl, auth.authenticatedClient) }
}
