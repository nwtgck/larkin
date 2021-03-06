import * as WebSocket from 'ws'
import { createDomain } from '@larkin/api/domain'
import { dockerPull, dockerRun } from '@larkin/api/facades/docker'
import { createNewNginxConfig, restartNginx } from '@larkin/api/facades/nginx'
import { logger } from '@larkin/api/services/logger'
import { isProduction } from '@larkin/api/helpers/environ'
import { Container } from '@larkin/api/models/Container'

const getPort = require('get-port')

export const onConnection = (ws: WebSocket) => {
  const handleStdIo = (data: any) => {
    logger.info(`stdout: ${data.toString()}`)
    try {
      ws.send(`[docker] ${data.toString()}`)
    } catch (e) {
      logger.info('websocket client is missing')
    }
  }

  const dockerLog = (message: string, newLine: boolean = false) => {
    logger.info(`[docker] ${message}`)
    try {
      ws.send(`${newLine ? '\n' : ''}[larkin.sh] ${message}`)
    } catch (e) {
      logger.info('websocket client is missing')
    }
  }

  ws.on('close', function() {
    logger.debug('connection closed.')
  })

  ws.on('message', async (image: string) => {
    const proxyPort = await getPort()

    dockerLog('====> STEP 1. Connecting to larkin.sh build server...')
    dockerLog('Successfully connected to larkin.sh build server. Build started.')

    dockerLog('====> STEP 2. Registering your domain...', true)
    const publicHostName = await createDomain()
    const protocol = isProduction ? 'https' : 'http'
    dockerLog(`Successfully registered domain: ${protocol}://${publicHostName}`)
    await createNewNginxConfig({ publicHostName, proxyPort, listenPort: 8080 })
    restartNginx()

    dockerLog(`====> STEP 3. Pulling ${image}...`, true)
    try {
      await dockerPull(image, handleStdIo)
    } catch (e) {
      dockerLog('Somthing went wrong. Try again later.')
      return
    }

    dockerLog('====> STEP 4. Running Docker container...', true)
    const internal_container_id = await dockerRun(image, proxyPort, handleStdIo, (ps: any) => {
      logger.info(`docker container is running at: :${proxyPort}`)
      setTimeout(async () => {
        dockerLog(
          'Killing docker container due to exceeding 600 seconds limit for demo instance.',
          true,
        )
        dockerLog('Thank you for applying demo. please Subscribe larkin.sh!')
        await Container.query()
          .update({ status: 'terminated' })
          .where({ internal_container_id })
        ps.kill()
      }, 600 * 1000)
    })

    await Container.query().insert({
      internal_container_id,
      status: 'running',
      image,
      public_host: publicHostName,
      proxy_host: 'localhost',
      proxy_port: proxyPort,
      // command: string,
    })
  })
}
