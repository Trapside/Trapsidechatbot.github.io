let songs = [];
let currentIndex = 0;
const audio = document.getElementById('mainAudio');

// Attempt to load from "Memory" (IndexedDB or LocalStorage)
// Note: Actual file handles require user gesture, but we can store song metadata
document.getElementById('btnOpen').addEventListener('click', async () => {
    try {
        const dirHandle = await window.showDirectoryPicker();
        songs = [];
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.mp3')) {
                const file = await entry.getFile();
                songs.push(file);
            }
        }
        renderSongs(songs);
    } catch (err) {
        console.error("Directory access denied or not supported.");
    }
});

function renderSongs(songsToRender) {
    const list = document.getElementById('songList');
    list.innerHTML = '';
    songsToRender.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `<span class="title">${file.name}</span><span class="artist">Local File</span>`;
        div.onclick = () => playSong(index);
        list.appendChild(div);
    });
}

function playSong(index) {
    currentIndex = index;
    const file = songs[index];
    audio.src = URL.createObjectURL(file);
    document.getElementById('trackName').innerText = file.name;
    document.getElementById('playBtn').innerText = '⏸';
    audio.play();
}

// Play/Pause Control
document.getElementById('playBtn').addEventListener('click', () => {
    if (audio.paused) {
        audio.play();
        document.getElementById('playBtn').innerText = '⏸';
    } else {
        audio.pause();
        document.getElementById('playBtn').innerText = '▶️';
    }
});

// Search Functionality
document.getElementById('searchBar').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = songs.filter(s => s.name.toLowerCase().includes(term));
    renderSongs(filtered);
});
