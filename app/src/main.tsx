import { Component, StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { applyDocumentLang, I18nProvider, readLang, translate } from "./lib/i18n"
import "./styles/styles.css"
import "./styles/tunnel.css"

const initialLang = readLang()
applyDocumentLang(initialLang)

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>{translate(readLang(), "Something went wrong")}</h1>
          <pre dir="ltr">{this.state.error.message}</pre>
          <button type="button" onClick={() => location.reload()}>
            {translate(readLang(), "Reload page")}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Boundary>
        <App />
      </Boundary>
    </I18nProvider>
  </StrictMode>,
)
