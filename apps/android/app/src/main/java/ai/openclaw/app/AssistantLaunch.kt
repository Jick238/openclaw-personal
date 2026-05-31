package ai.openclaw.app

import android.content.Intent

const val actionAskOpenClaw = "ai.openclaw.app.action.ASK_OPENCLAW"
const val actionOpenVoiceE2e = "ai.openclaw.app.debug.OPEN_VOICE_E2E"
const val extraAssistantPrompt = "prompt"

enum class HomeDestination {
  Connect,
  Chat,
  Voice,
  Screen,
  Settings,
}

/**
 * Normalized launch request from Android Assistant or explicit app actions.
 */
data class AssistantLaunchRequest(
  val source: String,
  val prompt: String?,
  val autoSend: Boolean,
)

fun parseHomeDestinationIntent(intent: Intent?): HomeDestination? {
  val action = intent?.action ?: return null
  return when {
    // Debug-only shortcut keeps E2E navigation out of release builds.
    BuildConfig.DEBUG && action == actionOpenVoiceE2e -> HomeDestination.Voice
    else -> null
  }
}

/**
 * Parse external assistant entry points without starting any UI side effects.
 */
fun parseAssistantLaunchIntent(intent: Intent?): AssistantLaunchRequest? {
  val action = intent?.action ?: return null
  return when (action) {
    Intent.ACTION_ASSIST ->
      AssistantLaunchRequest(
        source = "assist",
        prompt = null,
        autoSend = false,
      )

    actionAskOpenClaw -> {
      val prompt = intent.getStringExtra(extraAssistantPrompt)?.trim()?.ifEmpty { null }
      AssistantLaunchRequest(
        source = "app_action",
        prompt = prompt,
        autoSend = false,
      )
    }

    else -> null
  }
}
