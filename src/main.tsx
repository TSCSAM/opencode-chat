import { Component, StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles.css"

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>مشکلی پیش آمد</h1>
          <pre dir="ltr">{this.state.error.message}</pre>
          <button type="button" onClick={() => location.reload()}>
            بارگذاری مجدد
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
)
