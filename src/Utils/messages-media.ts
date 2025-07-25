import { Boom } from '@hapi/boom'
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import FormData from 'form-data'
import * as cheerio from 'cheerio'
import { exec } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs, writeFileSync, WriteStream } from 'fs'
import type { IAudioMetadata } from 'music-metadata'
import { tmpdir } from 'os'
import { join } from 'path'
import * as path from 'path'
import Jimp from 'jimp'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { proto } from '../../WAProto'
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults'
import {
	BaileysEventMap,
	DownloadableMessage,
	MediaConnInfo,
	MediaDecryptionKeyInfo,
	MediaType,
	MessageType,
	SocketConfig,
	WAGenericMediaMessage,
	WAMediaUpload,
	WAMediaUploadFunction,
	WAMessageContent
} from '../Types'
import {
	BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	jidNormalizedUser
} from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto'
import { generateMessageIDV2 } from './generics'
import { ILogger } from './logger'

const getTmpFilesDirectory = () => tmpdir()

const getImageProcessingLibrary = async() => {
	const [_jimp, sharp] = await Promise.all([
		(async() => {
			const jimp = await (
				import('jimp')
					.catch(() => { })
			)
			return jimp
		})(),
		(async() => {
			const sharp = await (
				import('sharp')
					.catch(() => { })
			)
			return sharp
		})()
	])

	if(sharp) {
		return { sharp }
	}

	const jimp = _jimp?.default || _jimp
	if(jimp) {
		return { jimp }
	}

	throw new Boom('No image processing library available')
}

export const hkdfInfoKey = (type: MediaType) => {
	const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type]
	return `WhatsApp ${hkdfInfo} Keys`
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(buffer: Uint8Array | string | null | undefined, mediaType: MediaType): Promise<MediaDecryptionKeyInfo> {
	if(!buffer) {
		throw new Boom('Cannot derive from empty media key')
	}

	if(typeof buffer === 'string') {
		buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	}

	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.slice(0, 16),
		cipherKey: expandedMediaKey.slice(16, 48),
		macKey: expandedMediaKey.slice(48, 80),
	}
}

interface UploadService {
	name: string
	url: string
	buildForm: () => FormData
	parseResponse: (res: AxiosResponse<any>) => string
}

export async function uploadFile(buffer: Buffer, logger?: ILogger): Promise<string> {
	const { fromBuffer } = await import('file-type')
	const fileType = await fromBuffer(buffer)
	if(!fileType) throw new Error("Failed to detect file type.")

	const { ext, mime } = fileType

	const services: UploadService[] = [
		{
			name: "catbox",
			url: "https://catbox.moe/user/api.php",
			buildForm: () => {
				const form = new FormData()
				form.append("fileToUpload", buffer, {
					filename: `file.${ext}`,
					contentType: mime || "application/octet-stream"
				})
				form.append("reqtype", "fileupload")
				return form
			},
			parseResponse: res => res.data as string
		},
		{
			name: "pdi.moe",
			url: "https://scdn.pdi.moe/upload",
			buildForm: () => {
				const form = new FormData()
				form.append("file", buffer, {
					filename: `file.${ext}`,
					contentType: mime
				})
				return form
			},
			parseResponse: res => res.data.result.url as string
		},
		{
			name: "qu.ax",
			url: "https://qu.ax/upload.php",
			buildForm: () => {
				const form = new FormData()
				form.append("files[]", buffer, {
					filename: `file.${ext}`,
					contentType: mime || "application/octet-stream"
				})
				return form
			},
			parseResponse: res => {
				if(!res.data?.files?.[0]?.url) throw new Error("Failed to get URL from qu.ax")
				return res.data.files[0].url
			}
		},
		{
			name: "uguu.se",
			url: "https://uguu.se/upload.php",
			buildForm: () => {
				const form = new FormData()
				form.append("files[]", buffer, {
					filename: `file.${ext}`,
					contentType: mime || "application/octet-stream"
				})
				return form
			},
			parseResponse: res => {
				if(!res.data?.files?.[0]?.url) throw new Error("Failed to get URL from uguu.se")
				return res.data.files[0].url
			}
		},
		{
			name: "tmpfiles",
			url: "https://tmpfiles.org/api/v1/upload",
			buildForm: () => {
				const form = new FormData()
				form.append("file", buffer, {
					filename: `file.${ext}`,
					contentType: mime
				})
				return form
			},
			parseResponse: res => {
				const match = (res.data.data.url as string).match(/https:\/\/tmpfiles\.org\/(.*)/)
				if(!match) throw new Error("Failed to parse tmpfiles URL.")
				return `https://tmpfiles.org/dl/${match[1]}`
			}
		}
	]

	for (const service of services) {
		try {
			const form = service.buildForm()
			const res = await axios.post(service.url, form, {
				headers: form.getHeaders()
			})
			const url = service.parseResponse(res)
			return url
		} catch (error) {
			logger?.debug(`[${service.name}] eror:`, error?.message || error)
		}
	}

	throw new Error("All upload services failed.")
}

export async function vid2jpg(videoUrl: string): Promise<string> {
	try {
		const { data } = await axios.get(
			`https://ezgif.com/video-to-jpg?url=${encodeURIComponent(videoUrl)}`
		)
		const $ = cheerio.load(data)

		const fileToken = $('input[name="file"]').attr("value")
		if(!fileToken) {
			throw new Error("Failed to retrieve file token. The video URL may be invalid or inaccessible.")
		}

		const formData = new URLSearchParams()
		formData.append("file", fileToken)
		formData.append("end", "1")
		formData.append("video-to-jpg", "Convert to JPG!")

		const convert = await axios.post(
			`https://ezgif.com/video-to-jpg/${fileToken}`,
			formData
		)
		const $2 = cheerio.load(convert.data)

		let imageUrl = $2("#output img").first().attr("src")
		if(!imageUrl) {
			throw new Error("Could not locate the converted image output.")
		}

		if(imageUrl.startsWith("//")) {
			imageUrl = "https:" + imageUrl
		} else if(imageUrl.startsWith("/")) {
			const cdnMatch = imageUrl.match(/\/(s\d+\..+?)\/.*/)
			if(cdnMatch) {
				imageUrl = "https://" + imageUrl.slice(2)
			} else {
				imageUrl = "https://ezgif.com" + imageUrl
			}
		}

		return imageUrl
	} catch (error) {
		throw new Error("Failed to convert video to JPG: " + error.message)
	}
}

/**
 * Originally written by Techwiz (https://github.com/techwiz37)
 * Modified for customization and improvements
 */
export const extractVideoThumb = async(videoPath: string) => {
	const videoBuffer = await fs.readFile(videoPath)
	const dataUrl = await uploadFile(videoBuffer)

	if(!dataUrl || typeof dataUrl !== 'string') {
		throw new Error('Failed to upload video: Invalid or missing URL')
	}

	const jpgUrl = await vid2jpg(dataUrl)
	const { data: imageBuffer } = await axios.get<Buffer>(jpgUrl, {
		responseType: 'arraybuffer',
	})

	return imageBuffer
}

export const extractImageThumb = async(bufferOrFilePath: Readable | Buffer | string, width = 32) => {
	if(bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath)
	}

	const lib = await getImageProcessingLibrary()
	if('sharp' in lib && typeof lib.sharp?.default === 'function') {
		const img = lib.sharp!.default(bufferOrFilePath)
		const dimensions = await img.metadata()

		const buffer = await img
			.resize(width)
			.jpeg({ quality: 50 })
			.toBuffer()
		return {
			buffer,
			original: {
				width: dimensions.width,
				height: dimensions.height,
			},
		}
	} else if('jimp' in lib && typeof lib.jimp?.read === 'function') {
		const { read, MIME_JPEG, RESIZE_BILINEAR, AUTO } = lib.jimp

		const jimp = await read(bufferOrFilePath as any)
		const dimensions = {
			width: jimp.getWidth(),
			height: jimp.getHeight()
		}
		const buffer = await jimp
			.quality(50)
			.resize(width, AUTO, RESIZE_BILINEAR)
			.getBufferAsync(MIME_JPEG)
		return {
			buffer,
			original: dimensions
		}
	} else {
		throw new Boom('No image processing library available')
	}
}

export const encodeBase64EncodedStringForUpload = (b64: string) => (
	encodeURIComponent(
		b64
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/\=+$/, '')
	)
)

export const generateProfilePicture = async(mediaUpload: WAMediaUpload) => {
	let bufferOrFilePath: Buffer | string
	let img: Promise<Buffer>

	if(Buffer.isBuffer(mediaUpload)) {
		bufferOrFilePath = mediaUpload
	} else if('url' in mediaUpload) {
		bufferOrFilePath = mediaUpload.url.toString()
	} else {
		bufferOrFilePath = await toBuffer(mediaUpload.stream)
	}

	const jimp = await Jimp.read(bufferOrFilePath as any)
	const cropped = jimp.getWidth() > jimp.getHeight() ? jimp.resize(550, -1) : jimp.resize(-1, 650)

		img = cropped
			.quality(100)
			.getBufferAsync(Jimp.MIME_JPEG)

	return {
		img: await img,
	}
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
	const media = Object.values(message)[0] as WAGenericMediaMessage
	return media?.fileSha256 && Buffer.from(media.fileSha256).toString ('base64')
}

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	const musicMetadata = await import('music-metadata')
	let metadata: IAudioMetadata
	const options = {
		duration: true
	}
	if(Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options)
	} else if(typeof buffer === 'string') {
		metadata = await musicMetadata.parseFile(buffer, options)
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options)
	}

	return metadata.format.duration
}

/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger) {
	try {
		const { default: decoder } = await eval('import(\'audio-decode\')')
		let audioData: Buffer
		if(Buffer.isBuffer(buffer)) {
			audioData = buffer
		} else if(typeof buffer === 'string') {
			const rStream = createReadStream(buffer)
			audioData = await toBuffer(rStream)
		} else {
			audioData = await toBuffer(buffer)
		}

		const audioBuffer = await decoder(audioData)

		const rawData = audioBuffer.getChannelData(0) // We only need to work with one channel of data
		const samples = 64 // Number of samples we want to have in our final data set
		const blockSize = Math.floor(rawData.length / samples) // the number of samples in each subdivision
		const filteredData: number[] = []
		for(let i = 0; i < samples; i++) {
		  	const blockStart = blockSize * i // the location of the first sample in the block
		  	let sum = 0
		  	for(let j = 0; j < blockSize; j++) {
				sum = sum + Math.abs(rawData[blockStart + j]) // find the sum of all the samples in the block
			}

			filteredData.push(sum / blockSize) // divide the sum by the block size to get the average
		}

		// This guarantees that the largest data point will be set to 1, and the rest of the data will scale proportionally.
		const multiplier = Math.pow(Math.max(...filteredData), -1)
		const normalizedData = filteredData.map((n) => n * multiplier)

		// Generate waveform like WhatsApp
		const waveform = new Uint8Array(
			normalizedData.map((n) => Math.floor(100 * n))
		)

		return waveform
	} catch(e) {
		logger?.debug('Failed to generate waveform: ' + e)
	}
}


export const toReadable = (buffer: Buffer) => {
	const readable = new Readable({ read: () => {} })
	readable.push(buffer)
	readable.push(null)
	return readable
}

export const toBuffer = async(stream: Readable) => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}

	stream.destroy()
	return Buffer.concat(chunks)
}

export const getStream = async(item: WAMediaUpload, opts?: AxiosRequestConfig) => {
	if(Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: 'buffer' } as const
	}

	if('stream' in item) {
		return { stream: item.stream, type: 'readable' } as const
	}

	if(item.url.toString().startsWith('http://') || item.url.toString().startsWith('https://')) {
		return { stream: await getHttpStream(item.url, opts), type: 'remote' } as const
	}

	return { stream: createReadStream(item.url), type: 'file' } as const
}

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
	file: string,
	mediaType: 'video' | 'image',
	options: {
        logger?: ILogger
    }
) {
	let thumbnail: string | undefined
	let originalImageDimensions: { width: number, height: number } | undefined
	if(mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if(original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height,
			}
		}
	} else if(mediaType === 'video') {
		try {
			const thumbnailBuffer = await extractVideoThumb(file)
			const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg')
			await fs.writeFile(imgFilename, thumbnailBuffer)
			const { buffer: processedThumbnailBuffer, original } = await extractImageThumb(imgFilename)
			thumbnail = processedThumbnailBuffer.toString('base64')
			if(original.width && original.height) {
				originalImageDimensions = {
					width: original.width,
					height: original.height,
				}
			}
			await fs.unlink(imgFilename)
		} catch(err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	}
}

export const getHttpStream = async(url: string | URL, options: AxiosRequestConfig & { isStream?: true } = {}) => {
	const fetched = await axios.get(url.toString(), { ...options, responseType: 'stream' })
	return fetched.data as Readable
}

type EncryptedStreamOptions = {
	saveOriginalFileIfRequired?: boolean
	logger?: ILogger
	opts?: AxiosRequestConfig
}

export const prepareStream = async(
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts }: EncryptedStreamOptions = {}
) => {

	const { stream, type } = await getStream(media, opts)

	logger?.debug('fetched media stream')

	let bodyPath: string | undefined
	let didSaveToTmpPath = false
	try {
		const buffer = await toBuffer(stream)
		if(type === 'file') {
			bodyPath = (media as any).url
		} else if(saveOriginalFileIfRequired) {
			bodyPath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2())
			writeFileSync(bodyPath, buffer)
			didSaveToTmpPath = true
		}

		const fileLength = buffer.length
		const fileSha256 = Crypto.createHash('sha256').update(buffer).digest()

		stream?.destroy()
		logger?.debug('prepare stream data successfully')

		return {
			mediaKey: undefined,
			encWriteStream: buffer,
			fileLength,
			fileSha256,
			fileEncSha256: undefined,
			bodyPath,
			didSaveToTmpPath
		}
	} catch (error) {
		// destroy all streams with error
		stream.destroy()

		if(didSaveToTmpPath) {
			try {
				await fs.unlink(bodyPath!)
			} catch(err) {
				logger?.error({ err }, 'failed to save to tmp path')
			}
		}

		throw error
	}
}

export const encryptedStream = async(
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts }: EncryptedStreamOptions = {}
) => {
	const { stream, type } = await getStream(media, opts)

	logger?.debug('fetched media stream')

	const mediaKey = Crypto.randomBytes(32)
	const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)
	const encWriteStream = new Readable({ read: () => {} })

	let bodyPath: string | undefined
	let writeStream: WriteStream | undefined
	let didSaveToTmpPath = false
	if(type === 'file') {
		bodyPath = (media as any).url
	} else if(saveOriginalFileIfRequired) {
		bodyPath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2())
		writeStream = createWriteStream(bodyPath)
		didSaveToTmpPath = true
	}

	let fileLength = 0
	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
	let hmac = Crypto.createHmac('sha256', macKey!).update(iv)
	let sha256Plain = Crypto.createHash('sha256')
	let sha256Enc = Crypto.createHash('sha256')

	try {
		for await (const data of stream) {
			fileLength += data.length

			if(
				type === 'remote'
				&& opts?.maxContentLength
				&& fileLength + data.length > opts.maxContentLength
			) {
				throw new Boom(
					`content length exceeded when encrypting "${type}"`,
					{
						data: { media, type }
					}
				)
			}

			sha256Plain = sha256Plain.update(data)
			if(writeStream) {
				if(!writeStream.write(data)) {
					await once(writeStream, 'drain')
				}
			}

			onChunk(aes.update(data))
		}

		onChunk(aes.final())

		const mac = hmac.digest().slice(0, 10)
		sha256Enc = sha256Enc.update(mac)

		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()

		encWriteStream.push(mac)
		encWriteStream.push(null)

		writeStream?.end()
		stream.destroy()

		logger?.debug('encrypted data successfully')

		return {
			mediaKey,
			encWriteStream,
			bodyPath,
			mac,
			fileEncSha256,
			fileSha256,
			fileLength,
			didSaveToTmpPath
		}
	} catch(error) {
		// destroy all streams with error
		encWriteStream.destroy()
		writeStream?.destroy()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()

		if(didSaveToTmpPath) {
			try {
				await fs.unlink(bodyPath!)
			} catch(err) {
				logger?.error({ err }, 'failed to save to tmp path')
			}
		}

		throw error
	}

	function onChunk(buff: Buffer) {
		sha256Enc = sha256Enc.update(buff)
		hmac = hmac.update(buff)
		encWriteStream.push(buff)
	}
}

const DEF_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16

const toSmallestChunkSize = (num: number) => {
	return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE
}

export type MediaDownloadOptions = {
    startByte?: number
    endByte?: number
	options?: AxiosRequestConfig<any>
}

export const getUrlFromDirectPath = (directPath: string) => `https://${DEF_HOST}${directPath}`

export const downloadContentFromMessage = async(
	{ mediaKey, directPath, url }: DownloadableMessage,
	type: MediaType,
	opts: MediaDownloadOptions = { }
) => {
	const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/')
	const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath!)
	if(!downloadUrl) {
		throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 })
	}

	const keys = await getMediaKeys(mediaKey, type)

	return downloadEncryptedContent(downloadUrl, keys, opts)
}

/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export const downloadEncryptedContent = async(
	downloadUrl: string,
	{ cipherKey, iv }: MediaDecryptionKeyInfo,
	{ startByte, endByte, options }: MediaDownloadOptions = { }
) => {
	let bytesFetched = 0
	let startChunk = 0
	let firstBlockIsIV = false
	// if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
	if(startByte) {
		const chunk = toSmallestChunkSize(startByte || 0)
		if(chunk) {
			startChunk = chunk - AES_CHUNK_SIZE
			bytesFetched = chunk

			firstBlockIsIV = true
		}
	}

	const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined

	const headers: AxiosRequestConfig['headers'] = {
		...options?.headers || { },
		Origin: DEFAULT_ORIGIN,
	}
	if(startChunk || endChunk) {
		headers!.Range = `bytes=${startChunk}-`
		if(endChunk) {
			headers!.Range += endChunk
		}
	}

	// download the message
	const fetched = await getHttpStream(
		downloadUrl,
		{
			...options || { },
			headers,
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
		}
	)

	let remainingBytes = Buffer.from([])

	let aes: Crypto.Decipher

	const pushBytes = (bytes: Buffer, push: (bytes: Buffer) => void) => {
		if(startByte || endByte) {
			const start = bytesFetched >= startByte! ? undefined : Math.max(startByte! - bytesFetched, 0)
			const end = bytesFetched + bytes.length < endByte! ? undefined : Math.max(endByte! - bytesFetched, 0)

			push(bytes.slice(start, end))

			bytesFetched += bytes.length
		} else {
			push(bytes)
		}
	}

	const output = new Transform({
		transform(chunk, _, callback) {
			let data = Buffer.concat([remainingBytes, chunk])

			const decryptLength = toSmallestChunkSize(data.length)
			remainingBytes = data.slice(decryptLength)
			data = data.slice(0, decryptLength)

			if(!aes) {
				let ivValue = iv
				if(firstBlockIsIV) {
					ivValue = data.slice(0, AES_CHUNK_SIZE)
					data = data.slice(AES_CHUNK_SIZE)
				}

				aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
				// if an end byte that is not EOF is specified
				// stop auto padding (PKCS7) -- otherwise throws an error for decryption
				if(endByte) {
					aes.setAutoPadding(false)
				}

			}

			try {
				pushBytes(aes.update(data), b => this.push(b))
				callback()
			} catch(error) {
				callback(error)
			}
		},
		final(callback) {
			try {
				pushBytes(aes.final(), b => this.push(b))
				callback()
			} catch(error) {
				callback(error)
			}
		},
	})
	return fetched.pipe(output, { end: true })
}

export function extensionForMediaMessage(message: WAMessageContent) {
	const getExtension = (mimetype: string) => mimetype.split(';')[0].split('/')[1]
	const type = Object.keys(message)[0] as MessageType
	let extension: string
	if(
		type === 'locationMessage' ||
		type === 'liveLocationMessage' ||
		type === 'productMessage'
	) {
		extension = '.jpeg'
	} else {
		const messageContent = message[type] as WAGenericMediaMessage
		extension = getExtension(messageContent.mimetype!)
	}

	return extension
}

export const getWAUploadToServer = (
	{ customUploadHosts, fetchAgent, logger, options }: SocketConfig,
	refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>,
): WAMediaUploadFunction => {
	return async(stream, { mediaType, fileEncSha256B64, newsletter, timeoutMs }) => {
		// send a query JSON to obtain the url & auth token to upload our media
		let uploadInfo = await refreshMediaConn(false)

		let urls: { mediaUrl: string, directPath: string, handle?: string } | undefined
		const hosts = [ ...customUploadHosts, ...uploadInfo.hosts ]

		const chunks: Buffer[] | Buffer = []
		if(!Buffer.isBuffer(stream)) {
			for await (const chunk of stream) {
				chunks.push(chunk)
			}
		}

		const reqBody = Buffer.isBuffer(stream) ? stream : Buffer.concat(chunks)
		fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)
		let media = MEDIA_PATH_MAP[mediaType]
		if(newsletter) {
			media = media?.replace('/mms/', '/newsletter/newsletter-')
		}

		for(const { hostname, maxContentLengthBytes } of hosts) {
			logger.debug(`uploading to "${hostname}"`)

			const auth = encodeURIComponent(uploadInfo.auth) // the auth token
			const url = `https://${hostname}${media}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`
			let result: any
			try {
				if(maxContentLengthBytes && reqBody.length > maxContentLengthBytes) {
					throw new Boom(`Body too large for "${hostname}"`, { statusCode: 413 })
				}

				const body = await axios.post(
					url,
					reqBody,
					{
						...options,
						headers: {
							...options.headers || { },
							'Content-Type': 'application/octet-stream',
							'Origin': DEFAULT_ORIGIN
						},
						httpsAgent: fetchAgent,
						timeout: timeoutMs,
						responseType: 'json',
						maxBodyLength: Infinity,
						maxContentLength: Infinity,
					}
				)
				result = body.data

				if(result?.url || result?.directPath) {
					urls = {
						mediaUrl: result.url,
						directPath: result.direct_path,
						handle: result.handle
					}
					break
				} else {
					uploadInfo = await refreshMediaConn(true)
					throw new Error(`upload failed, reason: ${JSON.stringify(result)}`)
				}
			} catch(error) {
				if(axios.isAxiosError(error)) {
					result = error.response?.data
				}

				const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname
				logger.warn({ trace: error.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`)
			}
		}

		if(!urls) {
			throw new Boom(
				'Media upload failed on all hosts',
				{ statusCode: 500 }
			)
		}

		return urls
	}
}

const getMediaRetryKey = (mediaKey: Buffer | Uint8Array) => {
	return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
}

/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export const encryptMediaRetryRequest = async(
	key: proto.IMessageKey,
	mediaKey: Buffer | Uint8Array,
	meId: string
) => {
	const recp: proto.IServerErrorReceipt = { stanzaId: key.id }
	const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish()

	const iv = Crypto.randomBytes(12)
	const retryKey = await getMediaRetryKey(mediaKey)
	const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id!))

	const req: BinaryNode = {
		tag: 'receipt',
		attrs: {
			id: key.id!,
			to: jidNormalizedUser(meId),
			type: 'server-error'
		},
		content: [
			// this encrypt node is actually pretty useless
			// the media is returned even without this node
			// keeping it here to maintain parity with WA Web
			{
				tag: 'encrypt',
				attrs: { },
				content: [
					{ tag: 'enc_p', attrs: { }, content: ciphertext },
					{ tag: 'enc_iv', attrs: { }, content: iv }
				]
			},
			{
				tag: 'rmr',
				attrs: {
					jid: key.remoteJid!,
					'from_me': (!!key.fromMe).toString(),
					// @ts-ignore
					participant: key.participant || undefined
				}
			}
		]
	}

	return req
}

export const decodeMediaRetryNode = (node: BinaryNode) => {
	const rmrNode = getBinaryNodeChild(node, 'rmr')!

	const event: BaileysEventMap['messages.media-update'][number] = {
		key: {
			id: node.attrs.id,
			remoteJid: rmrNode.attrs.jid,
			fromMe: rmrNode.attrs.from_me === 'true',
			participant: rmrNode.attrs.participant
		}
	}

	const errorNode = getBinaryNodeChild(node, 'error')
	if(errorNode) {
		const errorCode = +errorNode.attrs.code
		event.error = new Boom(
			`Failed to re-upload media (${errorCode})`,
			{ data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(errorCode) }
		)
	} else {
		const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt')
		const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p')
		const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv')
		if(ciphertext && iv) {
			event.media = { ciphertext, iv }
		} else {
			event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
		}
	}

	return event
}

export const decryptMediaRetryData = async(
	{ ciphertext, iv }: { ciphertext: Uint8Array, iv: Uint8Array },
	mediaKey: Uint8Array,
	msgId: string
) => {
	const retryKey = await getMediaRetryKey(mediaKey)
	const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId))
	return proto.MediaRetryNotification.decode(plaintext)
}

export const getStatusCodeForMediaRetry = (code: number) => MEDIA_RETRY_STATUS_MAP[code]

const MEDIA_RETRY_STATUS_MAP = {
	[proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
	[proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
	[proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
	[proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418,
} as const

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function __importStar(arg0: any): any {
	throw new Error('Function not implemented.')
}
