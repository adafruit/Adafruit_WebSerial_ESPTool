import urllib.request
import re
import base64
import zlib
import json

ESPTOOL_URL = "https://raw.githubusercontent.com/espressif/esptool/master/esptool/stub_flasher.py"
STUB_HEADERS = {
    "esp8266": "ESP8266ROM.STUB_CODE",
    "esp32": "ESP32ROM.STUB_CODE",
    "esp32s2": "ESP32S2ROM.STUB_CODE",
    "esp32s3": "ESP32S3ROM.STUB_CODE",
    "esp32c3": "ESP32C3ROM.STUB_CODE",
    "esp32h2": "ESP32H2BETA2ROM.STUB_CODE",
    "esp32c2": "ESP32C2ROM.STUB_CODE",
}
STUB_REGEX = ' = eval\(zlib.decompress\(base64\.b64decode\((.*?)\)\)\)'

print("Downloading esptool.py from GitHub...")
with urllib.request.urlopen(ESPTOOL_URL) as f:
    esptool_code = f.read().decode('utf-8')

print("Extracting Stubs from esptool.py...")
stubs = {}
for key, header in STUB_HEADERS.items():
    match = re.search(header + STUB_REGEX, esptool_code, flags=(re.MULTILINE + re.DOTALL))
    if match:
        print(f"Found {key}!")
        stubs[key] = eval(match.group(1))

print("Converting Stubs to JSON...")
for key, stub in stubs.items():
    code = eval(zlib.decompress(base64.b64decode(stub)))
    print("\nProcessing " + key)
    print("Text size:", str(len(code["text"])) + " bytes")
    print("Data size:", str(len(code["data"])) + " bytes")

    print(code["text"])
    print(base64.b64encode(code["text"]))
    code["text"] = base64.b64encode(code["text"]).decode("utf-8")
    code["data"] = base64.b64encode(code["data"]).decode("utf-8")

    jsondata = json.dumps(code)

    f  = open("../src/stubs/" + key + ".json", "w+")
    f.write(jsondata)
    f.close()
