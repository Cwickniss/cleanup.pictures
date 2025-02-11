import { DownloadIcon, EyeIcon } from '@heroicons/react/outline'
import React, { useCallback, useEffect, useState } from 'react'
import { useWindowSize } from 'react-use'
import { useFirebase } from './adapters/firebase'
import inpaint from './adapters/inpainting'
import Button from './components/Button'
import Slider from './components/Slider'
import { downloadImage, loadImage, shareImage, useImage } from './utils'

const TOOLBAR_SIZE = 200
const BRUSH_COLOR = 'rgba(189, 255, 1, 0.75)'

interface EditorProps {
  hd: boolean
  file: File
  original: File
}

interface Line {
  size?: number
  pts: { x: number; y: number }[]
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: Line[],
  color = BRUSH_COLOR
) {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  lines.forEach(line => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach(pt => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}

export default function Editor(props: EditorProps) {
  const { file, original, hd } = props
  const [brushSize, setBrushSize] = useState(40)
  const [image, isImageLoaded] = useImage(file)
  const [originalImage, isOriginalLoaded] = useImage(original)
  const [renders, setRenders] = useState<HTMLImageElement[]>([])
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [maskCanvas] = useState<HTMLCanvasElement>(() => {
    return document.createElement('canvas')
  })
  const [lines, setLines] = useState<Line[]>([{ pts: [] }])
  const [{ x, y }, setCoords] = useState({ x: -1, y: -1 })
  const [showBrush, setShowBrush] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [isInpaintingLoading, setIsInpaintingLoading] = useState(false)
  const [showSeparator, setShowSeparator] = useState(false)
  const firebase = useFirebase()
  const [scale, setScale] = useState(1)
  const windowSize = useWindowSize()

  const draw = useCallback(() => {
    if (!context) {
      return
    }
    context.clearRect(0, 0, context.canvas.width, context.canvas.height)
    const currRender = renders[renders.length - 1]
    if (currRender?.src) {
      context.drawImage(currRender, 0, 0)
    } else {
      context.drawImage(image, 0, 0)
    }
    const currentLine = lines[lines.length - 1]
    drawLines(context, [currentLine])
  }, [context, lines, image, renders])

  const refreshCanvasMask = useCallback(() => {
    if (!context?.canvas.width || !context?.canvas.height) {
      throw new Error('canvas has invalid size')
    }
    maskCanvas.width = context?.canvas.width
    maskCanvas.height = context?.canvas.height
    const ctx = maskCanvas.getContext('2d')
    if (!ctx) {
      throw new Error('could not retrieve mask canvas')
    }
    drawLines(ctx, lines, 'white')
  }, [context?.canvas.height, context?.canvas.width, lines, maskCanvas])

  // Reset when the file changes
  useEffect(() => {
    setRenders([])
    setLines([{ pts: [] }])
    setScale(1)
    setIsInpaintingLoading(false)
  }, [file])

  // Draw once the image image is loaded
  useEffect(() => {
    if (!context?.canvas) {
      return
    }
    if (isImageLoaded) {
      context.canvas.width = image.naturalWidth
      context.canvas.height = image.naturalHeight
      const rW = windowSize.width / image.naturalWidth
      const rH = (windowSize.height - TOOLBAR_SIZE) / image.naturalHeight
      if (rW < 1 || rH < 1) {
        setScale(Math.min(rW, rH))
      } else {
        setScale(1)
      }
      draw()
    }
  }, [context?.canvas, draw, image, isImageLoaded, firebase, windowSize])

  // Handle mouse interactions
  useEffect(() => {
    if (!firebase) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }

    const onMouseDown = (ev: MouseEvent) => {
      if (!image.src) {
        return
      }
      const currLine = lines[lines.length - 1]
      currLine.size = brushSize
      canvas.addEventListener('mousemove', onMouseDrag)
      window.addEventListener('mouseup', onPointerUp)
      onPaint(ev.offsetX, ev.offsetY)
    }
    const onMouseMove = (ev: MouseEvent) => {
      setCoords({ x: ev.pageX, y: ev.pageY })
    }
    const onPaint = (px: number, py: number) => {
      const currLine = lines[lines.length - 1]
      currLine.pts.push({ x: px, y: py })
      draw()
    }
    const onMouseDrag = (ev: MouseEvent) => {
      const px = ev.offsetX
      const py = ev.offsetY
      onPaint(px, py)
    }

    const onPointerUp = async () => {
      if (!image.src) {
        return
      }
      setIsInpaintingLoading(true)
      canvas.removeEventListener('mousemove', onMouseDrag)
      window.removeEventListener('mouseup', onPointerUp)
      refreshCanvasMask()
      try {
        const start = Date.now()
        firebase?.logEvent('inpaint_start')
        const { token } = await firebase.getAppCheckToken()
        const res = await inpaint(file, maskCanvas.toDataURL(), token)
        if (!res) {
          throw new Error('empty response')
        }
        // TODO: fix the render if it failed loading
        const newRender = new Image()
        await loadImage(newRender, res)
        renders.push(newRender)
        lines.push({ pts: [] } as Line)

        setRenders([...renders])
        setLines([...lines])

        firebase?.logEvent('inpaint_processed', {
          duration: Date.now() - start,
          width: image.naturalWidth,
          height: image.naturalHeight,
        })
      } catch (e: any) {
        firebase?.logEvent('inpaint_failed', {
          error: e,
        })
        // eslint-disable-next-line
        alert(e.message ? e.message : e.toString())
      }
      setIsInpaintingLoading(false)
      draw()
    }
    window.addEventListener('mousemove', onMouseMove)

    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      const currLine = lines[lines.length - 1]
      const coords = canvas.getBoundingClientRect()
      currLine.pts.push({
        x: (ev.touches[0].clientX - coords.x) / scale,
        y: (ev.touches[0].clientY - coords.y) / scale,
      })
      draw()
    }
    const onPointerStart = (ev: TouchEvent) => {
      if (!image.src) {
        return
      }
      const currLine = lines[lines.length - 1]
      currLine.size = brushSize
      canvas.addEventListener('mousemove', onMouseDrag)
      window.addEventListener('mouseup', onPointerUp)
      const coords = canvas.getBoundingClientRect()
      const px = (ev.touches[0].clientX - coords.x) / scale
      const py = (ev.touches[0].clientY - coords.y) / scale
      onPaint(px, py)
    }
    canvas.addEventListener('touchstart', onPointerStart)
    canvas.addEventListener('touchmove', onTouchMove)
    canvas.addEventListener('touchend', onPointerUp)
    canvas.onmouseenter = () => setShowBrush(true)
    canvas.onmouseleave = () => setShowBrush(false)
    canvas.onmousedown = onMouseDown

    return () => {
      canvas.removeEventListener('mousemove', onMouseDrag)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onPointerUp)
      canvas.removeEventListener('touchstart', onPointerStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onPointerUp)
      canvas.onmouseenter = null
      canvas.onmouseleave = null
      canvas.onmousedown = null
    }
  }, [
    brushSize,
    context,
    file,
    draw,
    lines,
    refreshCanvasMask,
    maskCanvas,
    image.src,
    renders,
    firebase,
    image.naturalHeight,
    image.naturalWidth,
    scale,
  ])

  const undo = useCallback(() => {
    const l = lines
    l.pop()
    l.pop()
    setLines([...l, { pts: [] }])
    const r = renders
    r.pop()
    setRenders([...r])
  }, [lines, renders])

  // Handle Cmd+Z
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!renders.length) {
        return
      }
      const isCmdZ = (event.metaKey || event.ctrlKey) && event.key === 'z'
      if (isCmdZ) {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [renders, undo])

  function download() {
    const base64 = hd ? renderOutput() : context?.canvas.toDataURL(file.type)
    if (!base64) {
      throw new Error('could not get canvas data')
    }
    const name = file.name.replace(/(\.[\w\d_-]+)$/i, '_cleanup$1')
    if (shareImage(base64, name)) {
      firebase?.logEvent('download', { mode: 'share' })
    } else {
      downloadImage(base64, name)
      firebase?.logEvent('download', { mode: 'download' })
    }
  }

  function renderOutput() {
    if (!originalImage || !isOriginalLoaded || !context?.canvas) {
      return
    }
    const patch = document.createElement('canvas')
    patch.width = originalImage.width
    patch.height = originalImage.height
    const patchCtx = patch.getContext('2d')
    if (!patchCtx) {
      throw new Error('Could not get patch context')
    }

    // Draw the inpainted image masked by the mask
    patchCtx?.drawImage(
      maskCanvas,
      0,
      0,
      originalImage.width,
      originalImage.height
    )
    patchCtx.globalCompositeOperation = 'source-in'
    patchCtx?.drawImage(
      context?.canvas,
      0,
      0,
      originalImage.width,
      originalImage.height
    )

    // Draw the final output
    const output = document.createElement('canvas')
    output.width = originalImage.width
    output.height = originalImage.height
    const outputCtx = output.getContext('2d')
    if (!patchCtx) {
      throw new Error('Could not get output context')
    }
    outputCtx?.drawImage(originalImage, 0, 0)
    outputCtx?.drawImage(patch, 0, 0)
    return outputCtx?.canvas.toDataURL(file.type)
  }

  return (
    <div
      className={[
        'flex flex-col items-center',
        isInpaintingLoading
          ? 'animate-pulse-fast pointer-events-none transition-opacity'
          : '',
        scale !== 1 ? 'pb-24' : '',
      ].join(' ')}
      style={{
        height: scale !== 1 ? image.naturalHeight * scale : undefined,
      }}
    >
      <div
        className={[scale !== 1 ? '' : 'relative'].join(' ')}
        style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
      >
        <canvas
          className="rounded-sm"
          style={showBrush ? { cursor: 'none' } : {}}
          ref={r => {
            if (r && !context) {
              const ctx = r.getContext('2d')
              if (ctx) {
                setContext(ctx)
              }
            }
          }}
        />
        <div
          className={[
            'absolute top-0 right-0 pointer-events-none',
            'overflow-hidden',
            'border-primary',
            showSeparator ? 'border-l-4' : '',
            // showOriginal ? 'border-opacity-100' : 'border-opacity-0',
          ].join(' ')}
          style={{
            width: showOriginal ? `${Math.round(image.naturalWidth)}px` : '0px',
            height: image.naturalHeight,
            transitionProperty: 'width, height',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '300ms',
          }}
        >
          <img
            className="absolute right-0"
            src={image.src}
            alt="original"
            width={`${image.naturalWidth}px`}
            height={`${image.naturalHeight}px`}
            style={{
              width: `${image.naturalWidth}px`,
              height: `${image.naturalHeight}px`,
              maxWidth: 'none',
            }}
          />
        </div>
      </div>

      {showBrush && (
        <div
          className="hidden sm:block absolute rounded-full border border-primary bg-primary bg-opacity-80 pointer-events-none"
          style={{
            width: `${brushSize * scale}px`,
            height: `${brushSize * scale}px`,
            left: `${x}px`,
            top: `${y}px`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}

      <div
        className={[
          'flex items-center w-full max-w-3xl',
          // 'space-x-1 sm:space-x-5',
          'py-4 sm:p-6',
          scale !== 1
            ? 'absolute bottom-0 justify-evenly'
            : 'relative justify-evenly sm:justify-between',
        ].join(' ')}
      >
        <Slider
          label={
            <span>
              <span className="hidden md:inline">Brush</span> Size
            </span>
          }
          min={10}
          max={150}
          value={brushSize}
          onChange={setBrushSize}
        />
        {renders.length ? (
          <>
            <Button
              icon={
                <svg
                  width="19"
                  height="9"
                  viewBox="0 0 19 9"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-6 h-6"
                >
                  <path
                    d="M2 1C2 0.447715 1.55228 0 1 0C0.447715 0 0 0.447715 0 1H2ZM1 8H0V9H1V8ZM8 9C8.55228 9 9 8.55229 9 8C9 7.44771 8.55228 7 8 7V9ZM16.5963 7.42809C16.8327 7.92721 17.429 8.14016 17.9281 7.90374C18.4272 7.66731 18.6402 7.07103 18.4037 6.57191L16.5963 7.42809ZM16.9468 5.83205L17.8505 5.40396L16.9468 5.83205ZM0 1V8H2V1H0ZM1 9H8V7H1V9ZM1.66896 8.74329L6.66896 4.24329L5.33104 2.75671L0.331035 7.25671L1.66896 8.74329ZM16.043 6.26014L16.5963 7.42809L18.4037 6.57191L17.8505 5.40396L16.043 6.26014ZM6.65079 4.25926C9.67554 1.66661 14.3376 2.65979 16.043 6.26014L17.8505 5.40396C15.5805 0.61182 9.37523 -0.710131 5.34921 2.74074L6.65079 4.25926Z"
                    fill="currentColor"
                  />
                </svg>
              }
              onClick={undo}
            />
            <Button
              icon={<EyeIcon className="w-6 h-6" />}
              onDown={ev => {
                ev.preventDefault()
                setShowSeparator(true)
                setShowOriginal(true)
              }}
              onUp={() => {
                setShowOriginal(false)
                setTimeout(() => setShowSeparator(false), 300)
              }}
            >
              {windowSize.width > 640 ? 'Original' : undefined}
            </Button>
          </>
        ) : (
          <></>
        )}

        <Button
          primary
          icon={<DownloadIcon className="w-6 h-6" />}
          disabled={!renders.length}
          onClick={download}
        >
          {windowSize.width > 640 ? 'Download' : undefined}
        </Button>
      </div>
    </div>
  )
}
