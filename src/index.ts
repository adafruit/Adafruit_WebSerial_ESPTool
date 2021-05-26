import { ESP_ROM_BAUD, Logger } from "./const";
import { ESPLoader } from "./esp_loader";
import { formatMacAddr } from "./util";

export {
  CHIP_FAMILY_ESP32,
  CHIP_FAMILY_ESP32S2,
  CHIP_FAMILY_ESP8266,
} from "./const";

export const connect = async (logger: Logger) => {
  // - Request a port and open a connection.
  const port = await navigator.serial.requestPort();

  logger.log("Connecting...");
  await port.open({ baudRate: ESP_ROM_BAUD });

  logger.log("Connected successfully.");

  const esploader = new ESPLoader(port, logger);
  await esploader.initialize();

  logger.log("Connected to " + esploader.chipName);
  logger.log("MAC Address: " + formatMacAddr(esploader.macAddr()));

  return esploader;
};
