package expo.modules.mpv

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoMpvModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoMpv")

    View(MpvView::class) {
      Events(
        "onLoad",
        "onProgress",
        "onPlayingChange",
        "onEnded",
        "onDimensions",
        "onError"
      )

      Prop("source") { view: MpvView, uri: String? ->
        view.setUri(uri)
      }

      Prop("paused") { view: MpvView, paused: Boolean ->
        view.applyPaused(paused)
      }

      Prop("rate") { view: MpvView, rate: Float ->
        view.applyRate(rate)
      }

      Prop("volume") { view: MpvView, volume: Float ->
        view.applyVolume(volume)
      }

      Prop("muted") { view: MpvView, muted: Boolean ->
        view.applyMuted(muted)
      }

      Prop("resizeMode") { view: MpvView, mode: String? ->
        view.applyResizeMode(mode)
      }

      Prop("enhancement") { view: MpvView, level: String? ->
        view.applyEnhancement(level)
      }
    }

    Function("seek") { positionMs: Double ->
      MpvView.seekActive(positionMs)
    }
  }
}
