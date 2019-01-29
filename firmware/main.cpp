/*
MIT License

Copyright (c) 2019 Micro:bit Educational Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

#include "MicroBit.h"
#include "mbFirmata.h"

MicroBit uBit;

int main() {
	uBit.init();
	uBit.serial.baud(57600);
	uBit.serial.setRxBufferSize(249);
	uBit.serial.setTxBufferSize(249);

	initFirmata();

	while (true) {
		stepFirmata();

		// Note: The following code is essential to avoid overrunning the serial line
		// and losing or currupting data, A fixed delay works, too, but a delay
		// long enough to handle the worst case (streaming 16 channels of analog data
		// and three digital ports, a total of 3 * 19 = 57 bytes) reduces the maximum
		// sampling rate for a single channel. This is like a SYNC_SPINWAIT for all
		// the serial data queued by the last call to stepFirmata().

		while (uBit.serial.txBufferedSize() > 0) /* wait for all bytes to be sent */;
	}
}
