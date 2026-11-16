using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace RCloneManagerVss {
    public static class NativeMethods {
        [DllImport("kernel32.dll", EntryPoint = "CreateSymbolicLinkW", ExactSpelling = true,
            CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.I1)]
        private static extern bool CreateSymbolicLink(string link, string target, int flags);
        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", ExactSpelling = true,
            CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string path, uint access, uint share,
            IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(SafeFileHandle handle, uint code,
            IntPtr input, uint inputSize, [Out] byte[] output, uint outputSize,
            out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll", EntryPoint = "RemoveDirectoryW", ExactSpelling = true,
            CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RemoveDirectory(string path);

        public static int CreateDirectoryLink(string link, string target) {
            if (CreateSymbolicLink(link, target, 1)) return 0;
            return Marshal.GetLastWin32Error();
        }

        public static string GetLinkTarget(string path) {
            // Open the reparse point itself, never follow its target.
            using (SafeFileHandle handle = CreateFile(path, 0, 7, IntPtr.Zero,
                3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                byte[] buffer = new byte[16384];
                uint returned;
                if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0,
                    buffer, (uint)buffer.Length, out returned, IntPtr.Zero)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return ParseLinkTarget(buffer, (int)returned);
            }
        }

        public static string ParseLinkTarget(byte[] buffer, int count) {
            if (buffer == null || count < 20 || count > buffer.Length ||
                BitConverter.ToUInt32(buffer, 0) != 0xA000000C) {
                throw new InvalidDataException("VSS_LINK_INVALID_REPARSE");
            }
            int dataLength = BitConverter.ToUInt16(buffer, 4);
            int offset = BitConverter.ToUInt16(buffer, 8);
            int length = BitConverter.ToUInt16(buffer, 10);
            if (dataLength < 12 || dataLength + 8 > count ||
                BitConverter.ToUInt32(buffer, 16) != 0 ||
                offset % 2 != 0 || length == 0 || length % 2 != 0 ||
                20 + offset + length > dataLength + 8) {
                throw new InvalidDataException("VSS_LINK_INVALID_REPARSE");
            }
            string target = Encoding.Unicode.GetString(buffer, 20 + offset, length);
            if (target.IndexOf('\0') >= 0) throw new InvalidDataException("VSS_LINK_INVALID_REPARSE");
            // NT substitute names can use \??\; compare the equivalent Win32 name.
            if (target.StartsWith(@"\??\", StringComparison.Ordinal)) {
                target = @"\\?\" + target.Substring(4);
            }
            return target;
        }
    }
}

namespace RCloneManagerVss {
    public static class PipeFactory {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct SecurityAttributes {
            public int Length;
            public System.IntPtr Descriptor;
            public int Inherit;
        }
        [System.Runtime.InteropServices.DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", ExactSpelling = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool ConvertDescriptor(string text, uint revision, out System.IntPtr descriptor, out uint size);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", ExactSpelling = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern Microsoft.Win32.SafeHandles.SafePipeHandle CreateNamedPipeW(string name, uint mode, uint pipeMode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern System.IntPtr LocalFree(System.IntPtr memory);
        public static System.IO.Pipes.NamedPipeServerStream Create(string name, string sid) {
            if (!System.Text.RegularExpressions.Regex.IsMatch(sid, @"^S-1-5-21-(\d+-){2}\d+-\d+$")) throw new System.IO.InvalidDataException("INVALID_SID");
            System.IntPtr descriptor;
            uint size;
            if (!ConvertDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + sid + ")", 1, out descriptor, out size)) {
                throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            }
            try {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = System.Runtime.InteropServices.Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.Descriptor = descriptor;
                // Overlapped, first instance, local clients only; a pre-existing pipe is rejected.
                var handle = CreateNamedPipeW(@"\\.\pipe\" + name, 0x40080003, 0x00000008, 1, 4096, 4096, 0, ref attributes);
                if (handle.IsInvalid) {
                    int code = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new System.ComponentModel.Win32Exception(code);
                }
                try { return new System.IO.Pipes.NamedPipeServerStream(System.IO.Pipes.PipeDirection.InOut, true, false, handle); }
                catch { handle.Dispose(); throw; }
            }
            finally { LocalFree(descriptor); }
        }
        public static string ReadLine(System.IO.StreamReader reader, int limit) {
            var text = new System.Text.StringBuilder();
            while (text.Length <= limit) {
                int value = reader.Read();
                if (value < 0) return text.Length == 0 ? null : text.ToString();
                if (value == 10) return text.ToString().TrimEnd('\r');
                text.Append((char)value);
            }
            throw new System.IO.InvalidDataException("MESSAGE_TOO_LONG");
        }
        public static string ClientSid(System.IO.Pipes.NamedPipeServerStream pipe) {
            string sid = null;
            pipe.RunAsClient(delegate {
                using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent()) { sid = identity.User.Value; }
            });
            return sid;
        }
    }
}
