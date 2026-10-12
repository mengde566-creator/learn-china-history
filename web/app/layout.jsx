import './globals.css'
import Nav from '@/components/Nav'

export const metadata = {
  title: '观史',
  description: '把史书里的一段历史，变成一个你可以走进去、可以开口问、走出来还记得住的场景。',
}

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 墨痕的边缘打毛滤镜。定义一次，所有墨痕共用。
            纸上的墨不会有干净的矢量边。 */}
        <svg className="svg-defs" aria-hidden="true" focusable="false">
          {/* 大墨痕：粗毛边 */}
          <filter id="ink-rough" x="-10%" y="-70%" width="120%" height="240%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85 0.35" numOctaves="3" seed="9" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          {/* 小墨痕：同样的位移量在小尺寸上会显得太噪，所以换一档细的 */}
          <filter id="ink-rough-sm" x="-14%" y="-90%" width="128%" height="280%">
            <feTurbulence type="fractalNoise" baseFrequency="1.4 0.6" numOctaves="3" seed="9" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        <Nav />
        {children}
      </body>
    </html>
  )
}
