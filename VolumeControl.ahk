#Requires AutoHotkey v2.0
#SingleInstance Force

; ============================================
; 音量精细控制脚本
; 单击音量键：±1
; 长按音量键：连续每次 ±5
; ============================================

; ── 配置 ──────────────────────────────────────
LONG_PRESS_MS := 300      ; 超过此毫秒数视为长按
REPEAT_MS    := 120       ; 长按后每次重复的间隔（越小越快）
STEP_SINGLE  := 1         ; 单击步长
STEP_LONG    := 5         ; 长按步长

; ── 工具函数 ──────────────────────────────────
SetVolume(delta) {
    try {
        curr := Round(SoundGetVolume())
        newVal := curr + delta
        if (newVal < 0)
            newVal := 0
        if (newVal > 100)
            newVal := 100
        SoundSetVolume(newVal)
        return newVal
    } catch {
        return -1
    }
}

; ── 音量加 ────────────────────────────────────
Volume_Up:: {
    longPressed := false

    ; 等待 LONG_PRESS_MS，若期间未松手则进入长按模式
    longPressTimer := SetTimer(() => (
        longPressed := true,
        SetVolume(STEP_LONG),
        SetTimer(() => (longPressed ? SetVolume(STEP_LONG) : ""), -REPEAT_MS)
    ), -LONG_PRESS_MS)

    KeyWait("Volume_Up")

    ; 关键：必须取消待触发的计时器，否则松手后仍会走长按分支
    SetTimer(longPressTimer, 0)

    if (!longPressed)
        SetVolume(STEP_SINGLE)   ; 单击：+1
}

; ── 音量减 ────────────────────────────────────
Volume_Down:: {
    longPressed := false

    longPressTimer := SetTimer(() => (
        longPressed := true,
        SetVolume(-STEP_LONG),
        SetTimer(() => (longPressed ? SetVolume(-STEP_LONG) : ""), -REPEAT_MS)
    ), -LONG_PRESS_MS)

    KeyWait("Volume_Down")
    SetTimer(longPressTimer, 0)

    if (!longPressed)
        SetVolume(-STEP_SINGLE)  ; 单击：-1
}
