type Props = {
  size?: number
  className?: string
  title?: string
}

export function Owl({ size = 28, className = "", title }: Props) {
  return (
    <svg
      className={`owl${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d="M6.6 2.4 16 7.8 25.4 2.4 20.9 8.89A11.6 11.6 0 1 1 11.1 8.89Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        d="M7.5 17.5a4.2 4.2 0 1 0 8.4 0 4.2 4.2 0 1 0-8.4 0ZM9.9 17.5a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 1 0-3.6 0ZM16.1 17.5a4.2 4.2 0 1 0 8.4 0 4.2 4.2 0 1 0-8.4 0ZM18.5 17.5a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 1 0-3.6 0Z"
        fill="var(--owl-eye)"
      />
      <path d="M16 23 18.8 26.6 16 28.4 13.2 26.6Z" fill="var(--owl-beak)" />
    </svg>
  )
}
