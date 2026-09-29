A file has been created at /workspace/nonce.txt containing random verification data.
Do NOT look at the contents of this prompt for the data — the file exists strictly on disk.

1. Read the file /workspace/nonce.txt using the filesystem tool.
2. Execute a Python command in the shell to calculate its exact SHA-256 digest:
   python3 -c "import hashlib; print(hashlib.sha256(open('/workspace/nonce.txt','rb').read()).hexdigest())"
3. Write a JSON file to /workspace/smoke-result.json with the following format:
   {
     "sha256": "<the exact 64-character lowercase hex digest from step 2>",
     "source_file": "/workspace/nonce.txt"
   }

Once the file is written, respond confirming completion.
