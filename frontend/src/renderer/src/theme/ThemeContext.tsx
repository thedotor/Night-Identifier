import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'

export type ThemeName = 'dark' | 'light' | 'red' | 'custom'

export interface CustomThemeColors {
  bg: string
  surface: string
  surfaceRaised: string
  border: string
  text: string
  textMuted: string
  accent: string
  accentMuted: string
}

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  customColors: CustomThemeColors
  setCustomColors: (c: CustomThemeColors) => void
}

const STORAGE_KEY = 'night-identifier:theme'
const CUSTOM_STORAGE_KEY = 'night-identifier:custom-theme'

const DEFAULT_CUSTOM: CustomThemeColors = {
  bg: '11 14 20',
  surface: '17 21 30',
  surfaceRaised: '24 29 40',
  border: '41 48 63',
  text: '226 232 240',
  textMuted: '148 159 178',
  accent: '99 179 237',
  accentMuted: '51 92 130'
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredTheme(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'red' || v === 'custom') return v
  } catch {
    /* localStorage unavailable */
  }
  return 'dark'
}

function readStoredCustom(): CustomThemeColors {
  try {
    const v = localStorage.getItem(CUSTOM_STORAGE_KEY)
    if (v) return { ...DEFAULT_CUSTOM, ...JSON.parse(v) }
  } catch {
    /* ignore malformed/missing storage */
  }
  return DEFAULT_CUSTOM
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [theme, setThemeState] = useState<ThemeName>(readStoredTheme)
  const [customColors, setCustomColorsState] = useState<CustomThemeColors>(readStoredCustom)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // the other window (the main one, or the second-monitor one) changed the theme: follow it
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) setThemeState(readStoredTheme())
      else if (e.key === CUSTOM_STORAGE_KEY) setCustomColorsState(readStoredCustom())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    const root = document.documentElement.style
    const customProperties = [
      '--color-bg',
      '--color-surface',
      '--color-surface-raised',
      '--color-border',
      '--color-text',
      '--color-text-muted',
      '--color-accent',
      '--color-accent-muted'
    ]

    if (theme !== 'custom') {
      // Inline styles beat the [data-theme] attribute selectors in theme.css,
      // so leftover custom overrides would otherwise silently keep winning
      // over whichever theme you switch to next.
      for (const prop of customProperties) root.removeProperty(prop)
      return
    }

    root.setProperty('--color-bg', customColors.bg)
    root.setProperty('--color-surface', customColors.surface)
    root.setProperty('--color-surface-raised', customColors.surfaceRaised)
    root.setProperty('--color-border', customColors.border)
    root.setProperty('--color-text', customColors.text)
    root.setProperty('--color-text-muted', customColors.textMuted)
    root.setProperty('--color-accent', customColors.accent)
    root.setProperty('--color-accent-muted', customColors.accentMuted)
  }, [theme, customColors])

  const setTheme = (t: ThemeName): void => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      /* ignore */
    }
  }

  const setCustomColors = (c: CustomThemeColors): void => {
    setCustomColorsState(c)
    try {
      localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(c))
    } catch {
      /* ignore */
    }
  }

  const value = useMemo(
    () => ({ theme, setTheme, customColors, setCustomColors }),
    [theme, customColors]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
