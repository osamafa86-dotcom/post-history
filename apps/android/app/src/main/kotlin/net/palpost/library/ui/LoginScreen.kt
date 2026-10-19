package net.palpost.library.ui

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import net.palpost.library.AppContainer
import net.palpost.library.R
import net.palpost.library.core.auth.AuthManager
import net.palpost.library.core.net.ApiFailure

data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val totp: String = "",
    val totpNeeded: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
)

class LoginViewModel(application: Application, private val auth: AuthManager) : AndroidViewModel(application) {
    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state

    fun onEmail(v: String) = _state.update { it.copy(email = v, error = null) }
    fun onPassword(v: String) = _state.update { it.copy(password = v, error = null) }
    fun onTotp(v: String) = _state.update { it.copy(totp = v.filter(Char::isDigit).take(6), error = null) }

    fun submit() {
        val s = _state.value
        if (s.busy || s.email.isBlank() || s.password.isBlank()) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                auth.login(s.email.trim(), s.password, s.totp.takeIf { it.isNotBlank() })
                _state.update { LoginUiState() }
            } catch (t: Throwable) {
                val totpNeeded = ApiFailure.from(t)?.code == "totp_required"
                _state.update { it.copy(busy = false, totpNeeded = it.totpNeeded || totpNeeded, error = describeFailure(getApplication(), t)) }
            }
        }
    }
}

@Composable
fun LoginScreen(container: AppContainer, sessionRevoked: Boolean) {
    val app = LocalContext.current.applicationContext as Application
    val vm: LoginViewModel = viewModel(factory = viewModelFactory { initializer { LoginViewModel(app, container.auth) } })
    val s by vm.state.collectAsStateWithLifecycle()
    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp).verticalScroll(rememberScrollState()).imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.login_title), style = MaterialTheme.typography.headlineMedium)
            if (sessionRevoked) Text(stringResource(R.string.login_session_revoked), color = MaterialTheme.colorScheme.error)
            OutlinedTextField(
                value = s.email, onValueChange = vm::onEmail, label = { Text(stringResource(R.string.login_email)) },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = s.password, onValueChange = vm::onPassword, label = { Text(stringResource(R.string.login_password)) },
                singleLine = true, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = s.totp, onValueChange = vm::onTotp, label = { Text(stringResource(R.string.login_totp)) },
                supportingText = { Text(stringResource(R.string.login_totp_help)) },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), modifier = Modifier.fillMaxWidth(),
                isError = s.totpNeeded && s.totp.length != 6,
            )
            s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = vm::submit, enabled = !s.busy && s.email.isNotBlank() && s.password.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(if (s.busy) R.string.login_in_progress else R.string.login_submit))
            }
        }
    }
}
